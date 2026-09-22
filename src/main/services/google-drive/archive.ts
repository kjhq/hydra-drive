import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { DriveError } from "./errors.js";

export async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export async function copyVerified(
  source: string,
  target: string,
  expectedHash?: string,
  expectedSize?: number
) {
  const stat = await fs.promises.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new DriveError("drive_invalid_backup");
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  if (
    (expectedSize !== undefined &&
      (await fs.promises.stat(target)).size !== expectedSize) ||
    (expectedHash && (await hashFile(target)) !== expectedHash)
  )
    throw new DriveError("drive_invalid_backup");
}
export async function pack(directory: string, destination: string) {
  const entries = await fs.promises.readdir(directory);
  await tar.c(
    {
      cwd: directory,
      file: destination,
      gzip: true,
      portable: true,
      noMtime: true,
    },
    entries
  );
}
export const safeArchivePath = (value: string) => {
  const clean = value.replace(/^\.\//, "").replace(/\/$/, "");
  return (
    Boolean(clean) &&
    !clean.includes("\\") &&
    !clean.includes("\0") &&
    !clean.includes(":") &&
    !clean.startsWith("/") &&
    !/^[A-Za-z]:/.test(clean) &&
    clean
      .split("/")
      .every(
        (part) =>
          part !== ".." &&
          part !== "." &&
          part !== "" &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)
      )
  );
};
// Validate before extraction; reject links, devices, duplicate files, traversal and oversized expansion.
export async function extractVerified(
  archive: string,
  target: string,
  expected: Map<string, { hash: string; size: number }>
) {
  const seen = new Set<string>();
  let invalid = false;
  await tar.t({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      const name = entry.path.replace(/^\.\//, "").replace(/\/$/, "");
      const item = expected.get(name);
      if (
        !safeArchivePath(entry.path) ||
        !["File", "Directory"].includes(entry.type)
      )
        invalid = true;
      if (entry.type === "File") {
        if (!item || item.size !== entry.size || seen.has(name)) invalid = true;
        seen.add(name);
      } else if (name !== "files") invalid = true;
      entry.resume();
    },
  });
  if (invalid || seen.size !== expected.size)
    throw new DriveError("drive_invalid_backup");
  await fs.promises.mkdir(target, { recursive: true });
  await tar.x({
    file: archive,
    cwd: target,
    strict: true,
    preservePaths: false,
    noChmod: true,
    filter: (name, entry) =>
      safeArchivePath(name) &&
      "type" in entry &&
      ["File", "Directory"].includes(entry.type),
  });
  for (const [name, item] of expected) {
    const file = path.join(target, name);
    if (
      !(await fs.promises.lstat(file)).isFile() ||
      (await hashFile(file)) !== item.hash
    )
      throw new DriveError("drive_invalid_backup");
  }
}
// Bound untrusted JSON before parsing it.
export async function readLimitedJson(
  response: Response,
  limit = 16 * 1024 * 1024
): Promise<unknown> {
  if (!response.body) throw new DriveError("drive_invalid_backup");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new DriveError("drive_invalid_backup");
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function extractLegacyArchive(archive: string, target: string) {
  let invalid = false,
    total = 0;
  const seen = new Set<string>();
  const limit = (await fs.promises.stat(archive)).size;
  await tar.t({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      const name = entry.path.replace(/^\.\//, "").replace(/\/$/, "");
      if (entry.type === "Directory" && (name === "." || name === "")) {
        entry.resume();
        return;
      }
      if (
        !safeArchivePath(entry.path) ||
        !["File", "Directory"].includes(entry.type)
      )
        invalid = true;
      if (entry.type === "File") {
        total += entry.size;
        if (seen.has(name) || total > limit) invalid = true;
        seen.add(name);
      }
      entry.resume();
    },
  });
  if (invalid) throw new DriveError("drive_invalid_backup");
  await fs.promises.mkdir(target, { recursive: true });
  await tar.x({
    file: archive,
    cwd: target,
    strict: true,
    preservePaths: false,
    noChmod: true,
  });
}
