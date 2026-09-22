import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DriveError } from "./errors.js";
import type { DriveFile } from "./http-client.js";
import { heads } from "./model.js";
import {
  DriveSaveStoreCore,
  type PublishInput,
  type SaveTransport,
} from "./save-store.js";
const identity = { kind: "legacy" as const, shop: "steam", objectId: "42" };
class FakeDrive implements SaveTransport {
  session = {
    accountId: "account-a",
    generation: 1,
    signal: new AbortController().signal,
  };
  files = new Map<string, { metadata: DriveFile; bytes: Buffer }>();
  sequence = 0;
  loseCommitResponse = false;
  events: string[] = [];
  async allocate(count = 1) {
    return Array.from({ length: count }, () => `id-${++this.sequence}`);
  }
  async metadata(id: string) {
    return this.files.get(id)?.metadata ?? null;
  }
  async create(value: Record<string, unknown>) {
    const metadata = {
      ...value,
      createdTime: new Date().toISOString(),
    } as unknown as DriveFile;
    this.files.set(metadata.id, { metadata, bytes: Buffer.alloc(0) });
    return metadata;
  }
  async list(query: string) {
    const role = query.match(/key='role' and value='([^']+)'/)?.[1],
      key = query.match(/key='identity' and value='([^']+)'/)?.[1];
    return [...this.files.values()]
      .map((f) => f.metadata)
      .filter(
        (f) =>
          !f.trashed &&
          (!role || f.appProperties?.role === role) &&
          (!key || f.appProperties?.identity === key) &&
          (!query.includes("mimeType=") || f.appProperties?.role === "root")
      );
  }
  async request(url: string) {
    const id = url.match(/^files\/([^?]+)/)?.[1];
    const entry = id ? this.files.get(id) : null;
    if (!entry) throw new DriveError("drive_backup_missing");
    return new Response(new Uint8Array(entry.bytes));
  }
  async update(id: string, value: Record<string, unknown>) {
    const file = this.files.get(id)!;
    file.metadata = {
      ...file.metadata,
      ...value,
      appProperties: {
        ...file.metadata.appProperties,
        ...((value.appProperties as Record<string, string>) ?? {}),
      },
    };
  }
  async upload(
    id: string,
    source: string,
    value: Record<string, unknown>,
    _url?: string,
    _persist?: (url: string) => Promise<void>
  ) {
    const bytes = await fs.readFile(source),
      role = (value.appProperties as Record<string, string>).role;
    this.events.push(role);
    if (!this.files.has(id))
      this.files.set(id, {
        metadata: {
          ...value,
          id,
          size: String(bytes.length),
          createdTime: new Date().toISOString(),
          sha256Checksum: createHash("sha256").update(bytes).digest("hex"),
        } as unknown as DriveFile,
        bytes,
      });
    if (role === "commit" && this.loseCommitResponse) {
      this.loseCommitResponse = false;
      throw new DriveError("drive_offline");
    }
  }
  async verifyContent(id: string, hash: string, size: number) {
    const entry = this.files.get(id);
    if (
      !entry ||
      entry.metadata.trashed ||
      entry.bytes.length !== size ||
      createHash("sha256").update(entry.bytes).digest("hex") !== hash
    )
      throw new DriveError("drive_invalid_backup");
  }
  async download(id: string, target: string, hash: string, size: number) {
    await this.verifyContent(id, hash, size);
    await fs.writeFile(target, this.files.get(id)!.bytes, { flag: "wx" });
  }
}
async function fixture(
  run: (
    store: DriveSaveStoreCore,
    drive: FakeDrive,
    input: PublishInput,
    root: string
  ) => Promise<void>
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "drive-store-test-")),
    drive = new FakeDrive();
  const store = new DriveSaveStoreCore(
      drive,
      path.join(root, "a"),
      root,
      root,
      () => {}
    ),
    archive = path.join(root, "save.tar.gz");
  await fs.writeFile(archive, "immutable snapshot");
  try {
    await run(
      store,
      drive,
      { identity, parentIds: [], label: "Save", archive },
      root
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
test("publishes archive before commit and removes queue only after verification", () =>
  fixture(async (store, drive, input) => {
    const id = await store.enqueue(input);
    assert.equal((await store.queue()).length, 1);
    const committed = await store.publishQueued(id);
    assert.deepEqual(drive.events, ["payload", "commit"]);
    assert.equal((await store.queue()).length, 0);
    assert.equal(await store.acceptedBase(identity), committed.id);
  }));
test("lost commit response retries idempotently and advances the accepted opaque base", () =>
  fixture(async (store, drive, input) => {
    drive.loseCommitResponse = true;
    const id = await store.enqueue(input);
    await assert.rejects(store.publishQueued(id), /drive_offline/);
    const original = (await store.records(identity))[0];
    assert(original);
    assert.equal(await store.acceptedBase(identity), null);
    const recovered = await store.publishQueued(id);
    assert.equal(recovered.id, original.id);
    assert.equal(await store.acceptedBase(identity), original.id);
    assert.equal((await store.queue()).length, 0);
    assert.equal(drive.events.filter((e) => e === "commit").length, 1);
  }));
test("tampered payload after ambiguous publication preserves the queued recovery copy", () =>
  fixture(async (store, drive, input) => {
    drive.loseCommitResponse = true;
    const id = await store.enqueue(input);
    await assert.rejects(store.publishQueued(id));
    const committed = (await store.records(identity))[0];
    const payload = drive.files.get(committed.archiveId!)!;
    payload.bytes = Buffer.alloc(payload.bytes.length, 120);
    await assert.rejects(store.publishQueued(id), /drive_invalid_backup/);
    assert.equal((await store.queue()).length, 1);
    assert.equal(await store.acceptedBase(identity), null);
  }));
test("switching account cannot see or publish another account's queued operation", () =>
  fixture(async (store, _drive, input, root) => {
    const id = await store.enqueue(input),
      otherDrive = new FakeDrive();
    otherDrive.session.accountId = "account-b";
    const other = new DriveSaveStoreCore(
      otherDrive,
      path.join(root, "b"),
      root,
      root,
      () => {}
    );
    assert.deepEqual(await other.queue(), []);
    await assert.rejects(other.publishQueued(id));
    assert.equal((await store.queue()).length, 1);
    assert.equal(otherDrive.events.length, 0);
  }));
test("offline stale publication remains a conflict with remote deletion", () =>
  fixture(async (store, _drive, input) => {
    const base = await store.publish(input),
      pending = await store.enqueue({ ...input, parentIds: [base.id] });
    await store.deleteAll(identity);
    const late = await store.publishQueued(pending),
      current = heads(await store.records(identity));
    assert.equal(current.length, 2);
    assert(current.some((c) => c.deleted));
    assert(current.some((c) => c.id === late.id));
  }));
test("retention preserves commit ancestry while retaining ten independent payloads", () =>
  fixture(async (store, drive, input) => {
    let parentIds: string[] = [];
    for (let i = 0; i < 13; i++) {
      const commit = await store.publish({ ...input, parentIds });
      parentIds = [commit.id];
    }
    const records = await store.records(identity);
    assert.equal(records.length, 13);
    assert.equal(heads(records).length, 1);
    const available = records.filter(
      (record) => !drive.files.get(record.archiveId!)!.metadata.trashed
    );
    assert.equal(available.length, 10);
  }));
