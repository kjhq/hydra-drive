import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { ClassicLevel } from "classic-level";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const ref = option("--ref", null);
const output = option("--output", ".cache/performance/idle-discovery.json");
const gamesCount = 100;
const ticks = 30;
await fs.promises.mkdir(path.join(root, ".cache/performance"), {
  recursive: true,
});
const fixture = await fs.promises.mkdtemp(
  path.join(root, ".cache/performance/discovery-")
);
const saveRoot = path.join(fixture, "saves");
const bundle = await build({
  stdin: {
    contents: `export { findNestedAchievementFiles } from './src/main/services/achievements/find-nested-achievement-files';
      ${ref ? "" : "export { createLibraryGamesSnapshot } from './src/main/services/library-games-snapshot';"}`,
    resolveDir: root,
  },
  platform: "node",
  format: "esm",
  bundle: true,
  write: false,
  alias: { "@shared": path.join(root, "src/shared/index.ts") },
  plugins: [
    {
      name: "isolated-discovery",
      setup(plugin) {
        // Replace only OS path lookup and logging. Discovery and filesystem work
        // execute the actual production source from the selected revision.
        plugin.onResolve({ filter: /^\.\/find-achievement-files$/ }, () => ({
          path: "fixture-roots",
          namespace: "fixture",
        }));
        plugin.onResolve({ filter: /^\.\.\/logger$/ }, () => ({
          path: "logger",
          namespace: "fixture",
        }));
        plugin.onLoad(
          { filter: /.*/, namespace: "fixture" },
          ({ path: name }) => ({
            contents:
              name === "fixture-roots"
                ? `import path from "node:path"; export const getEmulatorSaveFolders = (prefix = "") => [prefix ? path.join(prefix, "saves") : ${JSON.stringify(saveRoot)}];`
                : "export const achievementsLogger = { error() {} };",
          })
        );
        if (ref)
          plugin.onLoad({ filter: /\.ts$/ }, ({ path: file }) => {
            if (!file.startsWith(path.join(root, "src") + path.sep)) return;
            return {
              contents: execFileSync(
                "git",
                ["show", `${ref}:${path.relative(root, file)}`],
                { cwd: root, encoding: "utf8" }
              ),
              loader: "ts",
            };
          });
      },
    },
  ],
});
const production = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
let db;
let snapshot;
const originalReaddir = fs.promises.readdir;
try {
  for (let i = 0; i < gamesCount; i++) {
    const directory = path.join(saveRoot, String(i), "profile");
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(
      path.join(directory, "achievements.json"),
      "{}"
    );
  }
  let directoryReads = 0;
  fs.promises.readdir = async (...args) => {
    directoryReads++;
    return originalReaddir(...args);
  };
  const initialCpu = process.cpuUsage();
  const started = performance.now();
  for (let i = 0; i < ticks; i++) {
    const result = await production.findNestedAchievementFiles();
    assert.equal(result.size, gamesCount);
  }
  const discovery = {
    elapsedMs: performance.now() - started,
    cpuMicros: process.cpuUsage(initialCpu),
    directoryReads,
  };
  fs.promises.readdir = originalReaddir;

  const prefixes = Array.from({ length: 100 }, (_, i) =>
    path.join(fixture, `prefix-${i}`)
  );
  for (const prefix of prefixes) {
    const directory = path.join(prefix, "saves/123/profile");
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(
      path.join(directory, "achievements.json"),
      "{}"
    );
  }
  directoryReads = 0;
  fs.promises.readdir = async (...args) => {
    directoryReads++;
    return originalReaddir(...args);
  };
  const prefixesStarted = performance.now();
  for (let tick = 0; tick < ticks; tick++) {
    for (const prefix of prefixes)
      assert.equal(
        (await production.findNestedAchievementFiles(prefix)).size,
        1
      );
  }
  const separatePrefixes = {
    prefixes: prefixes.length,
    elapsedMs: performance.now() - prefixesStarted,
    directoryReads,
  };
  fs.promises.readdir = originalReaddir;

  db = new ClassicLevel(path.join(fixture, "db"), { valueEncoding: "json" });
  const games = db.sublevel("games", { valueEncoding: "json" });
  await games.batch(
    Array.from({ length: 3000 }, (_, i) => ({
      type: "put",
      key: `steam:${i}`,
      value: {
        shop: "steam",
        objectId: String(i),
        title: `Game ${i}`,
        isDeleted: false,
      },
    }))
  );
  let databaseScans = 0;
  const source = {
    prefixKey: (key) => games.prefixKey(key, "utf8"),
    values: () => ({
      all: () => {
        databaseScans++;
        return games.values().all();
      },
    }),
  };
  if (!ref) snapshot = production.createLibraryGamesSnapshot(db, source);
  const libraryStarted = performance.now();
  for (let i = 0; i < ticks; i++) {
    // The process watcher and achievement watcher both read the library.
    for (let watcher = 0; watcher < 2; watcher++) {
      const result = await (snapshot ? snapshot.read() : source.values().all());
      assert.equal(result.length, 3000);
    }
  }
  const library = {
    elapsedMs: performance.now() - libraryStarted,
    databaseScans,
  };
  // Confirm a real write is visible immediately, rather than buying speed by
  // serving stale library contents.
  await games.put("steam:new", {
    shop: "steam",
    objectId: "new",
    title: "New game",
    isDeleted: false,
  });
  assert.equal(
    (await (snapshot ? snapshot.read() : source.values().all())).length,
    3001
  );
  const report = {
    measuredAt: new Date().toISOString(),
    source: ref ?? "working-tree",
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    gamesCount,
    ticks,
    workload:
      "30 unchanged discovery cycles executed back-to-back, not an idle wall-clock CPU measurement",
    discovery,
    separatePrefixes,
    library,
    checks: [
      "same 100 games discovered on every cycle",
      "same 3000 library records returned",
      "new database write visible on next read",
    ],
  };
  await fs.promises.mkdir(path.dirname(path.resolve(output)), {
    recursive: true,
  });
  await fs.promises.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  if (args.includes("--check")) {
    assert.equal(discovery.directoryReads, 1 + gamesCount * 2);
    assert.equal(separatePrefixes.directoryReads, 300);
    assert.equal(library.databaseScans, 1);
  }
} finally {
  fs.promises.readdir = originalReaddir;
  snapshot?.dispose();
  await db?.close();
  await fs.promises.rm(fixture, { recursive: true, force: true });
}
