const fs = require("node:fs");
const YAML = require("yaml");
const config = YAML.parse(fs.readFileSync("electron-builder.yml", "utf8"));
const owner = process.env.MAIN_VITE_RELEASE_OWNER?.trim();
const repo = process.env.MAIN_VITE_RELEASE_REPO?.trim();
if (owner || repo) {
  if (
    !owner ||
    !repo ||
    !/^[A-Za-z0-9-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo)
  ) {
    throw new Error("Configure both fork release owner and repository");
  }
  if (`${owner}/${repo}`.toLowerCase() === "hydralauncher/hydra") {
    throw new Error("Hydra Drive cannot use the official Hydra release feed");
  }
  config.publish = [{ provider: "github", owner, repo }];
}
module.exports = config;
