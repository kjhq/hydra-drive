import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as tar from "tar";
import {
  extractVerified,
  hashFile,
  pack,
  readLimitedJson,
  safeArchivePath,
} from "./archive.js";
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "drive-archive-test-")
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
test("archive paths reject traversal, Windows devices, alternate streams, and aliases", () => {
  for (const name of [
    "../save",
    "/etc/save",
    "C:/save",
    "dir/../save",
    "dir\\save",
    "save:stream",
    "dir/CON.txt",
    "save.",
    "save ",
  ])
    assert.equal(safeArchivePath(name), false, name);
  assert.equal(safeArchivePath("files/a123"), true);
});
test("verified compressed snapshots round-trip bytes", () =>
  fixture(async (root) => {
    const content = path.join(root, "content");
    await fs.mkdir(content);
    const source = path.join(content, "save");
    await fs.writeFile(source, "game progress");
    const hash = await hashFile(source),
      archive = path.join(root, "snapshot.tar.gz");
    await pack(content, archive);
    await extractVerified(
      archive,
      path.join(root, "restored"),
      new Map([["save", { hash, size: 13 }]])
    );
    assert.equal(
      await fs.readFile(path.join(root, "restored/save"), "utf8"),
      "game progress"
    );
  }));
test("hash failure and unexpected files are rejected", () =>
  fixture(async (root) => {
    const content = path.join(root, "content");
    await fs.mkdir(content);
    await fs.writeFile(path.join(content, "save"), "bad");
    const archive = path.join(root, "snapshot.tar.gz");
    await pack(content, archive);
    await assert.rejects(
      extractVerified(
        archive,
        path.join(root, "a"),
        new Map([["save", { hash: "a".repeat(64), size: 3 }]])
      ),
      /drive_invalid_backup/
    );
    await assert.rejects(
      extractVerified(archive, path.join(root, "b"), new Map()),
      /drive_invalid_backup/
    );
  }));
test("symlink archives are rejected before extraction", () =>
  fixture(async (root) => {
    await fs.writeFile(path.join(root, "outside"), "outside");
    const content = path.join(root, "content");
    await fs.mkdir(content);
    await fs.symlink("../outside", path.join(content, "link"));
    const archive = path.join(root, "snapshot.tar");
    await tar.c({ cwd: content, file: archive }, ["link"]);
    await assert.rejects(
      extractVerified(archive, path.join(root, "restore"), new Map()),
      /drive_invalid_backup/
    );
    await assert.rejects(fs.stat(path.join(root, "restore")));
    assert.equal(
      await fs.readFile(path.join(root, "outside"), "utf8"),
      "outside"
    );
  }));
test("metadata is bounded before JSON parsing", async () => {
  await assert.rejects(
    readLimitedJson(new Response('"abcdefgh"'), 4),
    /drive_invalid_backup/
  );
  assert.deepEqual(await readLimitedJson(new Response('{"ok":true}')), {
    ok: true,
  });
});
