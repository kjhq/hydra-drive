import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { hashFile } from "./archive.js";
import type { DriveSession } from "./auth";
import { classifyDriveError, DriveError } from "./errors.js";

export interface DriveFile {
  id: string;
  name: string;
  createdTime: string;
  trashed?: boolean;
  size?: string;
  sha256Checksum?: string;
  appProperties?: Record<string, string>;
}
const API = "https://www.googleapis.com/drive/v3/";
export class DriveHttpClient {
  constructor(
    readonly session: DriveSession,
    private readonly authorization: {
      assert: (session: DriveSession) => void;
      accessToken: (session: DriveSession, force: boolean) => Promise<string>;
    },
    private readonly fetcher: typeof fetch = fetch
  ) {}
  async request(
    url: string,
    init: RequestInit = {},
    accepted: number[] = []
  ): Promise<Response> {
    const target = new URL(url, API);
    if (
      target.protocol !== "https:" ||
      target.hostname !== "www.googleapis.com" ||
      target.username ||
      target.password ||
      target.port
    )
      throw new DriveError("drive_invalid_backup");
    let refreshNeeded = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      this.authorization.assert(this.session);
      const token = await this.authorization.accessToken(
        this.session,
        attempt === 1 && refreshNeeded
      );
      refreshNeeded = false;
      let response: Response;
      try {
        response = await this.fetcher(target, {
          ...init,
          // Drive uses HTTP 308 with Location for resumable progress. Expose it to
          // the upload state machine while never following redirects with tokens.
          redirect: "manual",
          headers: {
            ...Object.fromEntries(new Headers(init.headers)),
            Authorization: `Bearer ${token}`,
          },
          signal: AbortSignal.any([
            this.session.signal,
            ...(init.signal ? [init.signal] : []),
            AbortSignal.timeout(90_000),
          ]),
        });
      } catch {
        this.authorization.assert(this.session);
        if (init.signal?.aborted) throw new DriveError("drive_cancelled");
        if (attempt === 4) throw new DriveError("drive_offline");
        await delay(500 * 2 ** attempt, undefined, {
          signal: this.session.signal,
        });
        continue;
      }
      this.authorization.assert(this.session);
      if (response.ok || accepted.includes(response.status)) return response;
      let reason: string | undefined;
      try {
        reason = (
          (await response.json()) as {
            error?: { errors?: { reason: string }[] };
          }
        ).error?.errors?.[0]?.reason;
      } catch {
        /* sanitized below */
      }
      const error = classifyDriveError(response.status, reason);
      if (response.status === 401 && attempt === 0) {
        refreshNeeded = true;
        continue;
      }
      if (
        (response.status >= 500 || error.code === "drive_rate_limited") &&
        attempt < 4
      ) {
        const retry = Number(response.headers.get("retry-after"));
        await delay(
          Math.min(
            30_000,
            Number.isFinite(retry) && retry > 0
              ? retry * 1000
              : 500 * 2 ** attempt
          ),
          undefined,
          { signal: this.session.signal }
        );
        continue;
      }
      throw error;
    }
    throw new DriveError("drive_request_failed");
  }
  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(url, init);
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }
  async list(query: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `trashed = false and (${query})`,
        spaces: "drive",
        pageSize: "1000",
        fields:
          "nextPageToken,files(id,name,createdTime,trashed,size,sha256Checksum,appProperties)",
        ...(pageToken ? { pageToken } : {}),
      });
      const page = await this.json<{
        files: DriveFile[];
        nextPageToken?: string;
      }>(`files?${params}`);
      files.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }
  async allocate(count = 1) {
    return (
      await this.json<{ ids: string[] }>(
        `files/generateIds?count=${count}&space=drive&type=files`
      )
    ).ids;
  }
  async metadata(id: string): Promise<DriveFile | null> {
    const response = await this.request(
      `files/${encodeURIComponent(id)}?fields=id,name,createdTime,trashed,size,sha256Checksum,appProperties`,
      {},
      [404]
    );
    return response.status === 404
      ? null
      : ((await response.json()) as DriveFile);
  }
  async create(metadata: Record<string, unknown>): Promise<DriveFile> {
    const response = await this.request(
      "files?fields=id,name,createdTime,appProperties",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadata),
      },
      [409]
    );
    if (response.status === 409 && typeof metadata.id === "string") {
      const existing = await this.metadata(metadata.id);
      if (existing) return existing;
    }
    if (!response.ok) throw new DriveError("drive_request_failed");
    return (await response.json()) as DriveFile;
  }
  async update(id: string, value: Record<string, unknown>) {
    await this.json(`files/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  }
  async upload(
    id: string,
    file: string,
    metadata: Record<string, unknown>,
    resumeUrl: string | undefined,
    persistUrl: (url: string) => Promise<void>
  ) {
    const size = (await fs.promises.stat(file)).size;
    let url = resumeUrl;
    let offset = 0;
    if (url) {
      const status = await this.request(
        url,
        {
          method: "PUT",
          headers: {
            "Content-Length": "0",
            "Content-Range": `bytes */${size}`,
          },
        },
        [308, 404, 410]
      );
      if (status.ok) {
        await this.verifyFile(id, file);
        return;
      }
      if (status.status === 308) offset = this.nextOffset(status, size);
      else url = undefined;
    }
    if (!url) {
      const existing = await this.metadata(id);
      if (existing) {
        await this.verifyFile(id, file);
        return;
      }
      const response = await this.request(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Upload-Content-Length": String(size),
            "X-Upload-Content-Type": "application/octet-stream",
          },
          body: JSON.stringify({ ...metadata, id }),
        },
        [409]
      );
      if (response.status === 409) {
        const complete = await this.metadata(id);
        if (complete) {
          await this.verifyFile(id, file);
          return;
        }
        throw new DriveError("drive_invalid_backup");
      }
      url = response.headers.get("location") ?? undefined;
      if (!url || new URL(url).hostname !== "www.googleapis.com")
        throw new DriveError("drive_request_failed");
      await persistUrl(url);
    }
    let recoveries = 0;
    const handle = await fs.promises.open(file, "r");
    try {
      while (offset < size) {
        const chunk = Buffer.alloc(Math.min(8 * 1024 * 1024, size - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (bytesRead !== chunk.length)
          throw new DriveError("drive_invalid_backup");
        const response = await this.request(
          url,
          {
            method: "PUT",
            body: new Uint8Array(chunk),
            headers: {
              "Content-Length": String(chunk.length),
              "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${size}`,
            },
          },
          [308, 400, 404, 410]
        );
        if (response.ok) {
          await this.verifyFile(id, file);
          return;
        }
        if (response.status !== 308) {
          if (++recoveries > 4) throw new DriveError("drive_request_failed");
          const probe = await this.request(
            url,
            {
              method: "PUT",
              headers: {
                "Content-Length": "0",
                "Content-Range": `bytes */${size}`,
              },
            },
            [308, 404, 410]
          );
          if (probe.ok) {
            await this.verifyFile(id, file);
            return;
          }
          if (probe.status !== 308) throw new DriveError("drive_offline");
          offset = this.nextOffset(probe, size);
          continue;
        }
        const next = this.nextOffset(response, size);
        if (next <= offset) throw new DriveError("drive_request_failed");
        offset = next;
        recoveries = 0;
      }
    } finally {
      await handle.close();
    }
  }
  async verifyFile(id: string, file: string) {
    await this.verifyContent(
      id,
      await hashFile(file),
      (await fs.promises.stat(file)).size
    );
  }
  async verifyContent(id: string, hash: string, size: number) {
    const metadata = await this.metadata(id);
    if (!metadata || metadata.trashed || Number(metadata.size) !== size)
      throw new DriveError("drive_invalid_backup");
    if (metadata.sha256Checksum) {
      if (metadata.sha256Checksum !== hash)
        throw new DriveError("drive_invalid_backup");
      return;
    }
    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "drive-verify-")
    );
    try {
      await this.download(id, path.join(directory, "payload"), hash, size);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
  private nextOffset(response: Response, size: number) {
    const range = response.headers.get("range");
    if (!range) return 0;
    const match = /^bytes=0-(\d+)$/.exec(range);
    const offset = match ? Number(match[1]) + 1 : NaN;
    if (!Number.isSafeInteger(offset) || offset > size)
      throw new DriveError("drive_invalid_backup");
    return offset;
  }
  async download(
    id: string,
    target: string,
    expectedHash: string,
    expectedSize: number,
    extraSignal?: AbortSignal
  ) {
    const response = await this.request(
      `files/${encodeURIComponent(id)}?alt=media`,
      { signal: extraSignal }
    );
    if (!response.body) throw new DriveError("drive_invalid_backup");
    const hash = createHash("sha256");
    let bytes = 0;
    const guard = new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > expectedSize)
          return done(new DriveError("drive_invalid_backup"));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(
          response.body as Parameters<typeof Readable.fromWeb>[0]
        ),
        guard,
        fs.createWriteStream(target, { flags: "wx", mode: 0o600 }),
        {
          signal: AbortSignal.any([
            this.session.signal,
            ...(extraSignal ? [extraSignal] : []),
          ]),
        }
      );
      this.authorization.assert(this.session);
      if (bytes !== expectedSize || hash.digest("hex") !== expectedHash)
        throw new DriveError("drive_invalid_backup");
    } catch (error) {
      await fs.promises.rm(target, { force: true });
      throw error;
    }
  }
}
