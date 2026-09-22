import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { hashFile } from "./archive.js";
import {
  assertSafeTarget,
  recoverRestores,
  restoreTransaction,
} from "./restore-transaction.js";
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "drive-test-"))
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
test("whole snapshot replacement deletes obsolete tracked files", () =>
  fixture(async (directory) => {
    const root = path.join(directory, "game");
    await fs.mkdir(root);
    const target = path.join(root, "save"),
      obsolete = path.join(root, "old"),
      source = path.join(directory, "download");
    await fs.writeFile(target, "before");
    await fs.writeFile(obsolete, "old");
    await fs.writeFile(source, "after");
    await restoreTransaction(
      "game",
      [
        { target, root, source, hash: await hashFile(source) },
        { target: obsolete, root },
      ],
      async () => {},
      path.join(directory, "journals")
    );
    assert.equal(await fs.readFile(target, "utf8"), "after");
    await assert.rejects(fs.stat(obsolete));
  }));
test("failure after replacement restores both original bytes and deleted files", () =>
  fixture(async (directory) => {
    const root = path.join(directory, "game");
    await fs.mkdir(root);
    const target = path.join(root, "save"),
      obsolete = path.join(root, "old"),
      source = path.join(directory, "download");
    await fs.writeFile(target, "before");
    await fs.writeFile(obsolete, "old");
    await fs.writeFile(source, "after");
    let calls = 0;
    await assert.rejects(
      restoreTransaction(
        "game",
        [
          { target, root, source, hash: await hashFile(source) },
          { target: obsolete, root },
        ],
        async () => {
          if (++calls === 3) throw new Error("simulated disk/session failure");
        },
        path.join(directory, "journals")
      )
    );
    assert.equal(await fs.readFile(target, "utf8"), "before");
    assert.equal(await fs.readFile(obsolete, "utf8"), "old");
  }));
test("wrong download hash never modifies live saves", () =>
  fixture(async (directory) => {
    const target = path.join(directory, "save"),
      source = path.join(directory, "download");
    await fs.writeFile(target, "before");
    await fs.writeFile(source, "tampered");
    await assert.rejects(
      restoreTransaction(
        "game",
        [{ target, root: directory, source, hash: "a".repeat(64) }],
        async () => {},
        path.join(directory, "journals")
      ),
      /drive_invalid_backup/
    );
    assert.equal(await fs.readFile(target, "utf8"), "before");
  }));
test("symlink and outside-root targets are refused", () =>
  fixture(async (directory) => {
    const real = path.join(directory, "real"),
      link = path.join(directory, "link");
    await fs.mkdir(real);
    await fs.symlink(real, link);
    await assert.rejects(
      assertSafeTarget(path.join(link, "save"), directory),
      /drive_invalid_backup/
    );
    await assert.rejects(
      assertSafeTarget(path.join(directory, "outside"), real),
      /drive_invalid_backup/
    );
  }));
test("restart recovers applying journal before next launch", () =>
  fixture(async (directory) => {
    const journals = path.join(directory, "journals"),
      pending = path.join(journals, "restore-test"),
      target = path.join(directory, "save");
    await fs.mkdir(pending, { recursive: true });
    await fs.writeFile(target, "half restored");
    await fs.writeFile(path.join(pending, "0.backup"), "original");
    await fs.writeFile(
      path.join(pending, "journal.json"),
      JSON.stringify({
        key: "game",
        phase: "applying",
        entries: [
          { target, root: directory, existed: true, previous: "0.backup" },
        ],
      })
    );
    await recoverRestores("game", async () => {}, journals);
    assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.deepEqual(await fs.readdir(journals), []);
  }));
test("overview recovery cannot roll back or delete an active restore journal", () =>
  fixture(async (directory) => {
    const target = path.join(directory, "save"),
      source = path.join(directory, "download"),
      root = path.join(directory, "journals");
    await fs.writeFile(target, "before");
    await fs.writeFile(source, "after");
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve)),
      started = new Promise<void>((resolve) => (entered = resolve));
    let calls = 0;
    const restore = restoreTransaction(
      "game",
      [{ target, root: directory, source, hash: await hashFile(source) }],
      async () => {
        if (++calls === 2) {
          entered();
          await blocked;
        }
      },
      root
    );
    await started;
    await assert.rejects(
      recoverRestores("game", async () => {}, root),
      /cloud_save_operation_active/
    );
    release();
    await restore;
    assert.equal(await fs.readFile(target, "utf8"), "after");
  }));
test("restored files retain snapshot timestamps and rollback retains original timestamps", () =>
  fixture(async (directory) => {
    const target = path.join(directory, "save"),
      source = path.join(directory, "download"),
      root = path.join(directory, "journals");
    await fs.writeFile(target, "before");
    await fs.writeFile(source, "after");
    const original = new Date("2025-01-01T00:00:00Z"),
      remote = "2026-02-01T00:00:00Z";
    await fs.utimes(target, original, original);
    let calls = 0;
    await assert.rejects(
      restoreTransaction(
        "game",
        [
          {
            target,
            root: directory,
            source,
            hash: await hashFile(source),
            lastModifiedAt: remote,
          },
        ],
        async () => {
          if (++calls === 3) throw new Error("interrupted after replacement");
        },
        root
      )
    );
    assert.equal((await fs.stat(target)).mtimeMs, original.getTime());
    assert.equal(await fs.readFile(target, "utf8"), "before");
    await restoreTransaction(
      "game",
      [
        {
          target,
          root: directory,
          source,
          hash: await hashFile(source),
          lastModifiedAt: remote,
        },
      ],
      async () => {},
      root
    );
    assert.equal((await fs.stat(target)).mtimeMs, Date.parse(remote));
  }));
