import type {
  DriveBackupSummary,
  DriveQueueSummary,
  DriveSaveIdentity,
  RestoreManifestResponse,
} from "@types";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyVerified, hashFile, readLimitedJson } from "./archive.js";
import { DriveError } from "./errors.js";
import type { DriveFile, DriveHttpClient } from "./http-client.js";
import {
  heads,
  identityKey,
  retentionCandidates,
  validateCommit,
  validId,
  type DriveCommit,
} from "./model.js";

const TAG = "hydra-drive-v1";
const tagged = `appProperties has { key='application' and value='${TAG}' }`;
interface Pending {
  id: string;
  accountId: string;
  createdAt: string;
  identity: DriveSaveIdentity;
  parentIds: string[];
  label: string;
  manifest?: RestoreManifestResponse;
  metadata: Record<string, unknown>;
  archiveHash: string;
  archiveSize: number;
  archiveId?: string;
  recordId?: string;
  uploadUrl?: string;
  recordUrl?: string;
  status: DriveQueueSummary["status"];
  error?: string;
}
export interface PublishInput {
  identity: DriveSaveIdentity;
  parentIds: string[];
  label: string;
  archive: string;
  manifest?: RestoreManifestResponse;
  metadata?: Record<string, unknown>;
}
export type SaveTransport = Pick<
  DriveHttpClient,
  | "session"
  | "list"
  | "allocate"
  | "create"
  | "metadata"
  | "request"
  | "upload"
  | "update"
  | "download"
  | "verifyContent"
>;
export class DriveSaveStoreCore {
  constructor(
    readonly client: SaveTransport,
    private readonly root: string,
    private readonly deviceRoot: string,
    private readonly tempRoot: string,
    private readonly assertSession: () => void
  ) {}
  private async write(file: string, value: unknown) {
    this.assertSession();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(value), {
      mode: 0o600,
    });
    this.assertSession();
    await fs.promises.rename(temporary, file);
  }
  async acceptedBase(identity: DriveSaveIdentity): Promise<string | null> {
    try {
      const value = JSON.parse(
        await fs.promises.readFile(
          path.join(this.root, "opaque-bases", `${identityKey(identity)}.json`),
          "utf8"
        )
      );
      return validId(value.id) ? value.id : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }
  async acceptBase(identity: DriveSaveIdentity, id: string) {
    await this.write(
      path.join(this.root, "opaque-bases", `${identityKey(identity)}.json`),
      { id }
    );
  }
  private async folder() {
    const folders = await this.client.list(
      `${tagged} and mimeType='application/vnd.google-apps.folder'`
    );
    if (folders.length)
      return folders.sort(
        (a, b) =>
          a.createdTime.localeCompare(b.createdTime) || a.id.localeCompare(b.id)
      )[0].id;
    const [id] = await this.client.allocate();
    return (
      await this.client.create({
        id,
        name: "Hydra Drive Saves",
        mimeType: "application/vnd.google-apps.folder",
        appProperties: { application: TAG, role: "root" },
      })
    ).id;
  }
  async records(identity?: DriveSaveIdentity): Promise<DriveCommit[]> {
    const query =
      `${tagged} and appProperties has {key='role' and value='commit'}` +
      (identity
        ? ` and appProperties has {key='identity' and value='${identityKey(identity)}'}`
        : "");
    const files = await this.client.list(query);
    const result: DriveCommit[] = [];
    // Search across all app-created folders, including concurrent duplicate roots.
    for (const file of files) {
      const commit = await this.readRecord(file);
      if (identity && identityKey(commit.identity) !== identityKey(identity))
        throw new DriveError("drive_invalid_backup");
      result.push(commit);
    }
    if (identity) heads(result); // Detect incomplete or tampered ancestry; never silently fall back.
    return result;
  }
  private async readRecord(file: DriveFile): Promise<DriveCommit> {
    if (
      file.trashed ||
      file.appProperties?.application !== TAG ||
      file.appProperties.role !== "commit"
    )
      throw new DriveError("drive_invalid_backup");
    const response = await this.client.request(`files/${file.id}?alt=media`);
    const commit = validateCommit(await readLimitedJson(response));
    if (
      commit.id !== file.id ||
      identityKey(commit.identity) !== file.appProperties.identity
    )
      throw new DriveError("drive_invalid_backup");
    return commit;
  }
  async record(id: string) {
    if (!validId(id)) throw new DriveError("drive_invalid_backup");
    const file = await this.client.metadata(id);
    if (!file) throw new DriveError("drive_backup_missing");
    return this.readRecord(file);
  }
  async history(identity: DriveSaveIdentity): Promise<DriveBackupSummary[]> {
    const records = await this.records(identity);
    const current = new Set(heads(records).map((c) => c.id));
    const result: DriveBackupSummary[] = [];
    for (const c of records.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
    )) {
      const payload = c.archiveId
        ? await this.client.metadata(c.archiveId)
        : null;
      const annotation = await this.client.metadata(c.id);
      result.push({
        id: c.id,
        identity: c.identity,
        parentIds: c.parentIds,
        createdAt: c.createdAt,
        deviceName: c.deviceName,
        label: annotation?.appProperties?.label ?? c.label,
        sizeBytes: c.archiveSize,
        current: current.has(c.id),
        conflict: current.size > 1 && current.has(c.id),
        deleted: c.deleted,
        available: Boolean(payload && !payload.trashed),
        pinned: annotation?.appProperties?.pinned === "true",
      });
    }
    return result;
  }
  async enqueue(input: PublishInput): Promise<string> {
    const id = randomUUID(),
      directory = path.join(this.root, "queue", id);
    await fs.promises.mkdir(directory, { recursive: true });
    try {
      await copyVerified(input.archive, path.join(directory, "payload.tar.gz"));
      const pending: Pending = {
        id,
        accountId: this.client.session.accountId,
        createdAt: new Date().toISOString(),
        identity: input.identity,
        parentIds: input.parentIds,
        label: input.label,
        manifest: input.manifest,
        metadata: input.metadata ?? {},
        archiveHash: await hashFile(path.join(directory, "payload.tar.gz")),
        archiveSize: (
          await fs.promises.stat(path.join(directory, "payload.tar.gz"))
        ).size,
        status: "queued",
      };
      await this.write(path.join(directory, "operation.json"), pending);
      return id;
    } catch (error) {
      await fs.promises.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async queue(): Promise<DriveQueueSummary[]> {
    const directory = path.join(this.root, "queue");
    const entries = await fs.promises.readdir(directory).catch(() => []);
    const result: DriveQueueSummary[] = [];
    for (const id of entries) {
      if (!validId(id)) continue;
      try {
        const op: Pending = JSON.parse(
          await fs.promises.readFile(
            path.join(directory, id, "operation.json"),
            "utf8"
          )
        );
        if (op.accountId === this.client.session.accountId)
          result.push({
            id,
            identity: op.identity,
            createdAt: op.createdAt,
            status: op.status,
            error: op.error,
          });
      } catch {
        /* Ignore staging directories without a durable operation record. */
      }
    }
    return result;
  }
  async publishQueued(id: string): Promise<DriveCommit> {
    if (!validId(id)) throw new DriveError("drive_invalid_backup");
    const directory = path.join(this.root, "queue", id),
      file = path.join(directory, "operation.json");
    const op: Pending = JSON.parse(await fs.promises.readFile(file, "utf8"));
    if (op.accountId !== this.client.session.accountId)
      throw new DriveError("drive_account_changed");
    const archive = path.join(directory, "payload.tar.gz");
    if ((await hashFile(archive)) !== op.archiveHash)
      throw new DriveError("drive_invalid_backup");
    try {
      const records = await this.records(op.identity);
      if (op.recordId && records.some((c) => c.id === op.recordId)) {
        const committed = records.find((c) => c.id === op.recordId)!;
        await this.verifyPublication(committed, op);
        if (op.identity.kind !== "pc")
          await this.acceptBase(op.identity, committed.id);
        await fs.promises.rm(directory, { recursive: true, force: true });
        return committed;
      }
      if (op.parentIds.some((parent) => !records.some((c) => c.id === parent)))
        throw new DriveError("drive_conflict");
      // Parent IDs stay frozen. Offline/concurrent changes become branches, never overwrites.
      if (!op.archiveId || !op.recordId) {
        [op.archiveId, op.recordId] = await this.client.allocate(2);
        await this.write(file, op);
      }
      const parent = await this.folder();
      await this.client.upload(
        op.archiveId,
        archive,
        {
          name: `${op.createdAt.replace(/:/g, "-")}-${id}.tar.gz`,
          parents: [parent],
          appProperties: {
            application: TAG,
            role: "payload",
            identity: identityKey(op.identity),
            operation: id,
          },
        },
        op.uploadUrl,
        async (url) => {
          op.uploadUrl = url;
          await this.write(file, op);
        }
      );
      const commit: DriveCommit = {
        schemaVersion: 1,
        id: op.recordId,
        parentIds: op.parentIds,
        identity: op.identity,
        createdAt: op.createdAt,
        deviceId: await this.deviceId(),
        deviceName: os.hostname(),
        label: op.label,
        archiveId: op.archiveId,
        archiveHash: op.archiveHash,
        archiveSize: op.archiveSize,
        deleted: false,
        metadata: op.metadata,
        ...(op.manifest
          ? {
              manifest: {
                ...op.manifest,
                snapshot: {
                  ...op.manifest.snapshot,
                  id: op.recordId,
                  version: 1,
                },
              },
            }
          : {}),
      };
      const recordPath = path.join(directory, "commit.json");
      await this.write(recordPath, commit);
      await this.client.upload(
        op.recordId,
        recordPath,
        {
          name: `${op.recordId}.json`,
          parents: [parent],
          appProperties: {
            application: TAG,
            role: "commit",
            identity: identityKey(op.identity),
          },
        },
        op.recordUrl,
        async (url) => {
          op.recordUrl = url;
          await this.write(file, op);
        }
      );
      // Read back and validate before removing the only durable retry journal.
      const confirmed = await this.record(op.recordId);
      await this.verifyPublication(confirmed, op);
      if (op.identity.kind !== "pc")
        await this.acceptBase(op.identity, confirmed.id);
      await fs.promises.rm(directory, { recursive: true, force: true });
      await this.retain(op.identity).catch(() => undefined); // Retention failure never invalidates a backup.
      return confirmed;
    } catch (error) {
      op.status =
        error instanceof DriveError && error.code === "drive_conflict"
          ? "conflict"
          : "failed";
      op.error =
        error instanceof DriveError ? error.code : "drive_request_failed";
      await this.write(file, op).catch(() => undefined);
      throw error;
    }
  }
  private async verifyPublication(commit: DriveCommit, op: Pending) {
    if (
      commit.archiveHash !== op.archiveHash ||
      commit.archiveId !== op.archiveId ||
      commit.archiveSize !== op.archiveSize ||
      identityKey(commit.identity) !== identityKey(op.identity) ||
      JSON.stringify(commit.parentIds) !== JSON.stringify(op.parentIds)
    )
      throw new DriveError("drive_invalid_backup");
    const metadata = await this.client.metadata(op.archiveId!);
    if (
      metadata?.appProperties?.application !== TAG ||
      metadata.appProperties.role !== "payload" ||
      metadata.appProperties.operation !== op.id
    )
      throw new DriveError("drive_invalid_backup");
    await this.client.verifyContent(
      op.archiveId!,
      op.archiveHash,
      op.archiveSize
    );
  }
  async publish(input: PublishInput) {
    return this.publishQueued(await this.enqueue(input));
  }
  private async deviceId() {
    const file = path.join(this.deviceRoot, "drive-device-id");
    try {
      return await fs.promises.readFile(file, "utf8");
    } catch {
      const id = randomUUID();
      try {
        await fs.promises.writeFile(file, id, { flag: "wx", mode: 0o600 });
        return id;
      } catch {
        return fs.promises.readFile(file, "utf8");
      }
    }
  }
  async download(commit: DriveCommit, target: string, signal?: AbortSignal) {
    if (!commit.archiveId || !commit.archiveHash || commit.deleted)
      throw new DriveError("drive_backup_missing");
    const metadata = await this.client.metadata(commit.archiveId);
    if (
      !metadata ||
      metadata.trashed ||
      metadata.appProperties?.application !== TAG ||
      metadata.appProperties.identity !== identityKey(commit.identity)
    )
      throw new DriveError("drive_backup_missing");
    await this.client.download(
      commit.archiveId,
      target,
      commit.archiveHash,
      commit.archiveSize,
      signal
    );
  }
  async annotate(id: string, values: { label?: string; pinned?: boolean }) {
    await this.record(id);
    const properties: Record<string, string> = {};
    if (values.label !== undefined) {
      if (Buffer.byteLength(values.label) > 100)
        throw new Error("Backup label must be at most 100 UTF-8 bytes");
      properties.label = values.label;
    }
    if (values.pinned !== undefined) properties.pinned = String(values.pinned);
    await this.client.update(id, { appProperties: properties });
  }
  async tombstone(identity: DriveSaveIdentity, parents?: string[]) {
    const records = await this.records(identity);
    const parentIds = parents ?? heads(records).map((c) => c.id);
    const [id] = await this.client.allocate();
    const folder = await this.folder();
    const directory = await fs.promises.mkdtemp(
      path.join(this.tempRoot, "drive-delete-")
    );
    try {
      const c: DriveCommit = {
        schemaVersion: 1,
        id,
        parentIds,
        identity,
        createdAt: new Date().toISOString(),
        deviceId: await this.deviceId(),
        deviceName: os.hostname(),
        label: "Deleted cloud backups",
        archiveId: null,
        archiveHash: null,
        archiveSize: 0,
        deleted: true,
        metadata: {},
      };
      const file = path.join(directory, "commit.json");
      await this.write(file, c);
      await this.client.upload(
        id,
        file,
        {
          name: `${id}.json`,
          parents: [folder],
          appProperties: {
            application: TAG,
            role: "commit",
            identity: identityKey(identity),
          },
        },
        undefined,
        async () => {}
      );
      return c;
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
  async deleteBackup(id: string) {
    const c = await this.record(id);
    const records = await this.records(c.identity);
    if (heads(records).some((head) => head.id === id))
      await this.tombstone(c.identity, [id]);
    if (c.archiveId) await this.client.update(c.archiveId, { trashed: true });
  }
  async deleteAll(identity: DriveSaveIdentity) {
    const records = await this.records(identity);
    await this.tombstone(
      identity,
      heads(records).map((c) => c.id)
    );
    for (const c of records)
      if (c.archiveId) await this.client.update(c.archiveId, { trashed: true });
  }
  private async retain(identity: DriveSaveIdentity) {
    const records = await this.records(identity);
    const pinned = new Set<string>();
    for (const c of records)
      if ((await this.client.metadata(c.id))?.appProperties?.pinned === "true")
        pinned.add(c.id);
    for (const c of retentionCandidates(records, pinned)) {
      if (c.archiveId) await this.client.update(c.archiveId, { trashed: true });
    }
  }
}
