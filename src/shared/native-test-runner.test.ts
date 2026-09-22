import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);

test("native test runner preserves Windows Path when locating cargo", () => {
  let childEnv: Record<string, string> | undefined;
  const script = fs.readFileSync("scripts/test-native-saves.cjs", "utf8");
  vm.runInNewContext(script, {
    __dirname: path.resolve("scripts"),
    process: {
      platform: "win32",
      env: {
        Path: "C:\\cargo\\bin;C:\\Windows",
        HYDRA_TORRENT_LIB_DIR: "C:\\bridge",
      },
      chdir() {
        // Keep the test process in its real checkout.
      },
    },
    require(name: string) {
      if (name === "node:path") return path.win32;
      if (name === "./build-torrent-bridge.cjs") return {};
      if (name === "node:fs") {
        return {
          realpathSync: (value: string) => value,
          mkdtempSync: () => "C:\\test-temp",
          rmSync() {
            // The fixture filesystem does not create a real directory.
          },
        };
      }
      if (name === "node:child_process") {
        return {
          spawnSync(
            command: string,
            _args: string[],
            options: { env: Record<string, string> }
          ) {
            assert.equal(command, "cargo");
            childEnv = options.env;
            return { status: 0 };
          },
        };
      }
      return require(name);
    },
  });
  assert.ok(childEnv);
  assert.deepEqual(
    Object.keys(childEnv).filter((key) => key.toLowerCase() === "path"),
    ["Path"]
  );
  assert.ok(childEnv.Path.endsWith(";C:\\cargo\\bin;C:\\Windows"));
  assert.ok(childEnv.Path.includes("C:\\bridge;"));
});
