import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DriveHttpClient } from "./http-client.js";
const session = {
  accountId: "account-a",
  generation: 1,
  signal: new AbortController().signal,
};
const auth = { assert: () => {}, accessToken: async () => "secret-token" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const client = (
  run: (url: string, init: RequestInit) => Response | Promise<Response>
) =>
  new DriveHttpClient(session, auth, async (url, init) =>
    run(String(url), init ?? {})
  );
test("lists every page, authenticates in main transport, and escapes queries", async () => {
  const urls: string[] = [];
  const c = client((url, init) => {
    urls.push(url);
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      "Bearer secret-token"
    );
    return urls.length === 1
      ? json({ files: [{ id: "one" }], nextPageToken: "two +" })
      : json({ files: [{ id: "two" }] });
  });
  assert.deepEqual(
    (await c.list("name='game'")).map((f) => f.id),
    ["one", "two"]
  );
  assert.equal(new URL(urls[1]).searchParams.get("pageToken"), "two +");
});
test("rejects redirects and foreign upload hosts before attaching tokens", async () => {
  const c = client(() => {
    throw new Error("must not send");
  });
  for (const url of [
    "https://evil.example/",
    "http://www.googleapis.com/",
    "https://name:pass@www.googleapis.com/",
    "https://www.googleapis.com:444/",
  ])
    await assert.rejects(c.request(url), /drive_invalid_backup/);
});
test("exposes resumable 308 without following its Location or forwarding tokens", async () => {
  const c = client((_url, init) => {
    assert.equal(init.redirect, "manual");
    return new Response(null, {
      status: 308,
      headers: { Location: "https://evil.example/", Range: "bytes=0-8388607" },
    });
  });
  assert.equal((await c.request("files/upload", {}, [308])).status, 308);
  await assert.rejects(c.request("files/upload"), /drive_request_failed/);
});
test("refreshes authorization once after a revoked access token", async () => {
  const forced: boolean[] = [];
  let requests = 0;
  const c = new DriveHttpClient(
    session,
    {
      ...auth,
      accessToken: async (_session, force) => {
        forced.push(force);
        return "token";
      },
    },
    async () => (++requests === 1 ? json({}, 401) : json({ ok: true }))
  );
  await c.request("files");
  assert.deepEqual(forced, [false, true]);
});
test("quota errors expose no API response or credentials", async () => {
  const c = client(() =>
    json(
      {
        error: {
          message: "private details",
          errors: [{ reason: "storageQuotaExceeded" }],
        },
      },
      403
    )
  );
  await assert.rejects(c.request("files"), { message: "drive_quota_exceeded" });
});
test("same-length modified retry payload is never accepted", async () => {
  const c = client(() =>
    json({ id: "file", size: "3", sha256Checksum: "b".repeat(64) })
  );
  await assert.rejects(
    c.verifyContent("file", "a".repeat(64), 3),
    /drive_invalid_backup/
  );
});
test("missing checksum falls back to verifying streamed bytes", async () => {
  const bytes = Buffer.from("save"),
    hash = createHash("sha256").update(bytes).digest("hex");
  const c = client((url) =>
    url.includes("alt=media")
      ? new Response(bytes)
      : json({ id: "file", size: "4" })
  );
  await c.verifyContent("file", hash, 4);
  await assert.rejects(
    c.verifyContent("file", "a".repeat(64), 4),
    /drive_invalid_backup/
  );
});
test("resumes upload at acknowledged offset and verifies the completed file", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "drive-http-test-")
  );
  const file = path.join(directory, "save"),
    bytes = Buffer.from("abcdef");
  await fs.writeFile(file, bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  let probe = false,
    chunk = false;
  const c = client((url, init) => {
    const headers = new Headers(init.headers);
    if (url.includes("upload-session")) {
      if (headers.get("Content-Range") === "bytes */6") {
        probe = true;
        return new Response(null, {
          status: 308,
          headers: { Range: "bytes=0-2" },
        });
      }
      assert.equal(headers.get("Content-Range"), "bytes 3-5/6");
      assert.equal(Buffer.from(init.body as Uint8Array).toString(), "def");
      chunk = true;
      return json({ id: "file" });
    }
    return json({ id: "file", size: "6", sha256Checksum: hash });
  });
  try {
    await c.upload(
      "file",
      file,
      {},
      "https://www.googleapis.com/upload-session",
      async () => {}
    );
    assert.ok(probe && chunk);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
