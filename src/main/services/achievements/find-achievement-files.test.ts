import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";

test("an unreadable emulator root does not hide achievements in other roots", async () => {
  const fixture = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "waypoint-discovery-test-")
  );
  const bundle = await build({
    entryPoints: [path.join(import.meta.dirname, "find-achievement-files.ts")],
    platform: "node",
    format: "esm",
    bundle: true,
    write: false,
    define: { "process.platform": '"linux"' },
    alias: { "@shared": path.resolve("src/shared/index.ts") },
    plugins: [
      {
        name: "isolated-system",
        setup(plugin) {
          plugin.onResolve(
            { filter: /^\.\.\/(logger|system-path|steam|wine)$/ },
            ({ path: name }) => ({ path: name, namespace: "fixture" })
          );
          plugin.onLoad(
            { filter: /.*/, namespace: "fixture" },
            ({ path: name }) => ({
              contents: {
                "../logger":
                  "export const achievementsLogger = { error() {} };",
                "../system-path":
                  'export const SystemPath = { getPath: () => "/home/testuser" };',
                "../steam":
                  "export const getSteamUsersIds = async () => []; export const getSteamLocation = async () => null;",
                "../wine":
                  "export const Wine = { getEffectivePrefixPath: p => p };",
              }[name],
            })
          );
        },
      },
    ],
  });
  const { findAllAchievementFiles } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const original = fs.promises.readdir;
  let denied = false;
  try {
    const file = path.join(
      fixture,
      "drive_c/users/testuser/AppData/Roaming/Goldberg SteamEmu Saves/123/achievements.json"
    );
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, "{}");
    fs.promises.readdir = ((...args: Parameters<typeof original>) => {
      if (String(args[0]).endsWith("Steam/CODEX")) {
        denied = true;
        return Promise.reject(
          Object.assign(new Error("permission denied"), { code: "EACCES" })
        );
      }
      return original(...args);
    }) as typeof original;
    const found = await findAllAchievementFiles(fixture);
    assert.equal(denied, true);
    assert.deepEqual(
      found.get("123")?.map((entry: { filePath: string }) => entry.filePath),
      [file]
    );
  } finally {
    fs.promises.readdir = original;
    await fs.promises.rm(fixture, { recursive: true, force: true });
  }
});
