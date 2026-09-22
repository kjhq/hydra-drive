const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
(async () => {
  if (!process.env.HYDRA_DRIVE_QUALIFICATION_REPORT)
    throw new Error(
      "Set HYDRA_DRIVE_QUALIFICATION_REPORT; this command creates disposable data in the connected account's Drive."
    );
  const { loadEnv } = await import("vite");
  const env = loadEnv("production", process.cwd(), "MAIN_VITE_GOOGLE_");
  const define = {};
  for (const key of [
    "MAIN_VITE_GOOGLE_CLIENT_ID",
    "MAIN_VITE_GOOGLE_CLIENT_SECRET",
  ])
    define[`import.meta.env.${key}`] = JSON.stringify(
      process.env[key] || env[key] || ""
    );
  const output = path.resolve(".cache/drive-live-qualification.cjs");
  await require("esbuild").build({
    entryPoints: ["scripts/qualify-drive-live.ts"],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    define,
  });
  fs.chmodSync(output, 0o600);
  const child = spawn(require("electron"), [output], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
