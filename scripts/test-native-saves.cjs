const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildTorrentBridge } = require("./build-torrent-bridge.cjs");
const root = path.resolve(__dirname, "..");
process.chdir(root);
const library = process.env.HYDRA_TORRENT_LIB_DIR || buildTorrentBridge();
// Native path tests compare canonical filesystem paths, including on macOS.
const temporary = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "hydra-drive-tests-"))
);
try {
  const env = {
    ...process.env,
    HYDRA_TORRENT_LIB_DIR: library,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  };
  const runtime = path.join(root, "hydra-native");
  for (const key of ["PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"]) {
    // Windows commonly spells this "Path". Adding "PATH" to the copied
    // environment would shadow it and hide cargo from the child process.
    const envKey =
      process.platform === "win32"
        ? Object.keys(env).find((name) => name.toUpperCase() === key) || key
        : key;
    env[envKey] = [runtime, library, env[envKey]]
      .filter(Boolean)
      .join(path.delimiter);
  }
  const result = spawnSync(
    "cargo",
    [
      "test",
      "--manifest-path",
      "native/hydra-native/Cargo.toml",
      "--features",
      "napi/dyn-symbols",
      "cloud_save",
      "--",
      "--test-threads=4",
    ],
    { env, stdio: "inherit" }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
