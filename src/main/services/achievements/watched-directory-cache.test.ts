import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createWatchedDirectoryCache } from "./watched-directory-cache.js";

function fakeWatch() {
  const watchers: Array<
    EventEmitter & {
      close: () => void;
      changed: (event?: string) => void;
      closed: boolean;
    }
  > = [];
  const watch = ((
    _path: string,
    _options: unknown,
    listener: (event: string) => void
  ) => {
    const watcher = Object.assign(new EventEmitter(), {
      closed: false,
      close() {
        this.closed = true;
      },
      changed: (event = "change") => listener(event),
    });
    watchers.push(watcher);
    return watcher;
  }) as unknown as typeof fs.watch;
  return { watch, watchers };
}

test("unchanged discovery is reused; changes and reconciliation rescan", async () => {
  const watched = fakeWatch();
  let time = 0,
    scans = 0;
  const cache = createWatchedDirectoryCache<number>({
    watch: watched.watch,
    now: () => time,
  });
  const scan = async () => ++scans;
  for (let tick = 0; tick < 30; tick++) {
    time = tick * 2000;
    assert.equal(await cache.get("/fixture", scan), 1);
  }
  watched.watchers[0].changed();
  assert.equal(await cache.get("/fixture", scan), 2);
  time += 60_000;
  assert.equal(await cache.get("/fixture", scan), 3);
  cache.clear();
  assert.ok(watched.watchers.every((w) => w.closed));
});

test("shares in-flight discovery and retains invalidation received during a scan", async () => {
  const watched = fakeWatch();
  const cache = createWatchedDirectoryCache<number>({ watch: watched.watch });
  let complete!: (value: number) => void;
  let scans = 0;
  const first = cache.get("/fixture", () => {
    scans++;
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const second = cache.get("/fixture", async () => ++scans);
  await Promise.resolve();
  watched.watchers[0].changed();
  complete(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(await cache.get("/fixture", async () => ++scans), 2);
  cache.clear();
});

test("watch failure falls back to scanning; retryable scan errors are not cached", async () => {
  const cache = createWatchedDirectoryCache<number>({
    watch: (() => {
      throw Object.assign(new Error("unsupported"), { code: "ENOSYS" });
    }) as typeof fs.watch,
  });
  let scans = 0;
  const scan = async () => ++scans;
  assert.equal(await cache.get("/fixture", scan), 1);
  assert.equal(await cache.get("/fixture", scan), 2);
  await assert.rejects(
    cache.get("/fixture", async () => {
      throw new Error("retry");
    }),
    /retry/
  );
  assert.equal(await cache.get("/fixture", scan), 3);
  cache.clear();
});

test("watcher errors and root renames rearm, and inactivity releases handles", async () => {
  const watched = fakeWatch();
  const cache = createWatchedDirectoryCache<number>({
    watch: watched.watch,
    idleMs: 30,
  });
  let scans = 0;
  const scan = async () => ++scans;
  await cache.get("/a", scan);
  watched.watchers[0].emit("error", new Error("watch lost"));
  assert.equal(await cache.get("/a", scan), 2);
  assert.ok(watched.watchers[0].closed);
  watched.watchers[1].changed("rename");
  assert.equal(await cache.get("/a", scan), 3);
  assert.ok(watched.watchers[1].closed);
  await delay(80);
  assert.ok(watched.watchers[2].closed);
  cache.clear();
});

test("a missing save root is discovered when created beneath a watched ancestor", async () => {
  const temporary = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "waypoint-watch-test-")
  );
  const root = path.join(temporary, "missing", "saves");
  const cache = createWatchedDirectoryCache<string[]>();
  const scan = () => fs.promises.readdir(root).catch(() => [] as string[]);
  try {
    assert.deepEqual(await cache.get(root, scan), []);
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(path.join(root, "achievements.json"), "{}");
    let files: string[] = [];
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !files.length) {
      await delay(20);
      files = await cache.get(root, scan);
    }
    assert.deepEqual(files, ["achievements.json"]);
  } finally {
    cache.clear();
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
});

test("a large active library retains all prefixes and shares missing-root watchers", async () => {
  const watched = fakeWatch();
  const watch = ((root: string, options: unknown, listener: unknown) => {
    if (root !== path.resolve("/fixture"))
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return (
      watched.watch as unknown as (
        root: string,
        options: unknown,
        listener: unknown
      ) => fs.FSWatcher
    )(root, options, listener);
  }) as typeof fs.watch;
  const cache = createWatchedDirectoryCache<number>({ watch, now: () => 0 });
  let scans = 0;
  try {
    for (let tick = 0; tick < 30; tick++) {
      for (let prefix = 0; prefix < 100; prefix++) {
        for (let folder = 0; folder < 18; folder++) {
          await cache.get(
            `/fixture/prefix-${prefix}/folder-${folder}`,
            async () => ++scans
          );
        }
      }
    }
    assert.equal(scans, 1800);
    assert.equal(watched.watchers.length, 1);
    watched.watchers[0].changed("rename");
    assert.ok(watched.watchers[0].closed);
    await cache.get("/fixture/prefix-0/folder-0", async () => ++scans);
    assert.equal(scans, 1801);
    await cache.get("/fixture/prefix-1/folder-0", async () => ++scans);
    assert.equal(watched.watchers.length, 2);
    watched.watchers[1].changed();
    await cache.get("/fixture/prefix-0/folder-0", async () => ++scans);
    assert.equal(scans, 1803);
  } finally {
    cache.clear();
  }
  assert.ok(watched.watchers.every((w) => w.closed));
});
