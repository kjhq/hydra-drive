const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
// A real path inside the checkout avoids macOS /var aliases, Windows 8.3
// temp-directory aliases, and system-directory restore protection rules.
const parent = path.resolve(".cache/test-tmp");
fs.mkdirSync(parent, { recursive: true });
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(parent, "run-")));
try {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/register-ts-node.mjs",
      "--test",
      "src/**/*.test.ts",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        TMPDIR: temporary,
        TMP: temporary,
        TEMP: temporary,
      },
    }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temporary, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
