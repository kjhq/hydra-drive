import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ClassicLevel } from "classic-level";
import { createLibraryGamesSnapshot } from "./library-games-snapshot.js";

test("reuses reads and invalidates for direct writes, root/sublevel batches, deletions and clears", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "waypoint-library-cache-")
  );
  const db = new ClassicLevel<string, { title: string }>(directory, {
    valueEncoding: "json",
  });
  const games = db.sublevel<string, { title: string }>("games", {
    valueEncoding: "json",
  });
  let scans = 0;
  const snapshot = createLibraryGamesSnapshot(db, {
    prefixKey: (key) => games.prefixKey(key, "utf8"),
    values: () => ({
      all: () => {
        scans++;
        return games.values().all();
      },
    }),
  });
  try {
    await games.put("a", { title: "A" });
    for (let i = 0; i < 60; i++)
      assert.deepEqual(await snapshot.read(), [{ title: "A" }]);
    assert.equal(scans, 1);
    await db.put("preferences", { title: "unrelated" });
    await snapshot.read();
    assert.equal(scans, 1);
    await games.put("a", { title: "Updated" });
    assert.deepEqual(await snapshot.read(), [{ title: "Updated" }]);
    await db.batch().put("b", { title: "B" }, { sublevel: games }).write();
    assert.equal((await snapshot.read()).length, 2);
    await games.batch([{ type: "del", key: "a" }]);
    assert.deepEqual(await snapshot.read(), [{ title: "B" }]);
    await games.del("b");
    assert.deepEqual(await snapshot.read(), []);
    await games.put("c", { title: "C" });
    await snapshot.read();
    await games.clear();
    assert.deepEqual(await snapshot.read(), []);
    await games.put("d", { title: "D" });
    await snapshot.read();
    await db.clear();
    assert.deepEqual(await snapshot.read(), []);
  } finally {
    snapshot.dispose();
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a write racing an initial read cannot publish a stale snapshot", async () => {
  const db = new EventEmitter();
  let resolve!: (value: number[]) => void;
  let reads = 0;
  const snapshot = createLibraryGamesSnapshot(db, {
    prefixKey: () => "!games!",
    values: () => ({
      all: async () =>
        ++reads === 1
          ? new Promise<number[]>((yes) => {
              resolve = yes;
            })
          : [2],
    }),
  });
  const first = snapshot.read();
  const second = snapshot.read();
  db.emit("write", [{ key: "!games!a" }]);
  resolve([1]);
  assert.deepEqual(await first, [2]);
  assert.deepEqual(await second, [2]);
  assert.equal(reads, 2);
  snapshot.dispose();
});
