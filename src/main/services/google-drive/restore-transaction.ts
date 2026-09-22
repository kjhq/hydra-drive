import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { copyVerified, hashFile } from "./archive.js";
import { DriveError } from "./errors.js";

export interface RestoreChange {
  target: string;
  root: string;
  source?: string;
  hash?: string;
  lastModifiedAt?: string;
}
interface JournalEntry extends RestoreChange {
  previous?: string;
  existed: boolean;
  previousMtime?: number;
  previousMode?: number;
}
interface Journal {
  key: string;
  phase: "prepared" | "applying" | "complete";
  entries: JournalEntry[];
}
export async function assertSafeTarget(target: string, root: string) {
  const resolved = path.resolve(target),
    base = path.resolve(root),
    relative = path.relative(base, resolved);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new DriveError("drive_invalid_backup");
  let current = resolved;
  // Reject links all the way to the filesystem root, including an existing restore root.
  for (;;) {
    try {
      if ((await fs.promises.lstat(current)).isSymbolicLink())
        throw new DriveError("drive_invalid_backup");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
async function saveJournal(directory: string, journal: Journal) {
  await fs.promises.writeFile(
    path.join(directory, "journal.tmp"),
    JSON.stringify(journal),
    { mode: 0o600 }
  );
  await fs.promises.rename(
    path.join(directory, "journal.tmp"),
    path.join(directory, "journal.json")
  );
}
async function rollback(directory: string, journal: Journal) {
  for (const entry of [...journal.entries].reverse()) {
    await assertSafeTarget(entry.target, entry.root);
    if (entry.existed && entry.previous) {
      const backup = path.join(directory, entry.previous);
      await fs.promises.mkdir(path.dirname(entry.target), { recursive: true });
      const temporary = `${entry.target}.${randomUUID()}.restore`;
      await fs.promises.copyFile(backup, temporary);
      if (entry.previousMtime !== undefined)
        await fs.promises.utimes(
          temporary,
          new Date(entry.previousMtime),
          new Date(entry.previousMtime)
        );
      if (entry.previousMode !== undefined)
        await fs.promises.chmod(temporary, entry.previousMode & 0o777);
      await fs.promises.rename(temporary, entry.target);
    } else {
      await fs.promises.rm(entry.target, { force: true });
    }
  }
}
async function recoverRestoresUnlocked(
  key: string,
  guard: () => Promise<void>,
  root: string
) {
  const entries = await fs.promises.readdir(root).catch(() => []);
  for (const name of entries) {
    if (!/^[\w-]+$/.test(name)) continue;
    const directory = path.join(root, name);
    const text = await fs.promises
      .readFile(path.join(directory, "journal.json"), "utf8")
      .catch(() => null);
    if (!text) continue;
    const journal = JSON.parse(text) as Journal;
    if (journal.key !== key) continue;
    await guard();
    if (journal.phase === "applying") await rollback(directory, journal);
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}
async function restoreTransactionUnlocked(
  key: string,
  changes: RestoreChange[],
  guard: () => Promise<void>,
  root: string
) {
  await recoverRestoresUnlocked(key, guard, root);
  const targets = new Set<string>();
  for (const entry of changes) {
    await assertSafeTarget(entry.target, entry.root);
    const normalized =
      process.platform === "win32"
        ? path.resolve(entry.target).toLowerCase()
        : path.resolve(entry.target);
    if (targets.has(normalized)) throw new DriveError("drive_invalid_backup");
    targets.add(normalized);
    if (
      entry.lastModifiedAt !== undefined &&
      !Number.isFinite(Date.parse(entry.lastModifiedAt))
    )
      throw new DriveError("drive_invalid_backup");
    if (
      entry.source &&
      (!entry.hash || (await hashFile(entry.source)) !== entry.hash)
    )
      throw new DriveError("drive_invalid_backup");
  }
  await fs.promises.mkdir(root, { recursive: true });
  const directory = await fs.promises.mkdtemp(path.join(root, "restore-"));
  const journal: Journal = { key, phase: "prepared", entries: [] };
  try {
    for (const [index, entry] of changes.entries()) {
      let existed = false,
        previousMtime: number | undefined,
        previousMode: number | undefined;
      try {
        const stat = await fs.promises.lstat(entry.target);
        existed = stat.isFile();
        previousMtime = stat.mtimeMs;
        previousMode = stat.mode;
        if (!existed) throw new DriveError("drive_invalid_backup");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const previous = existed ? `${index}.backup` : undefined;
      if (previous)
        await copyVerified(entry.target, path.join(directory, previous));
      journal.entries.push({
        ...entry,
        existed,
        previous,
        previousMtime,
        previousMode,
      });
    }
    await saveJournal(directory, journal);
    await guard();
    // Re-check sources and targets after staging to catch game/file changes before the transaction.
    for (const entry of journal.entries) {
      await assertSafeTarget(entry.target, entry.root);
      if (
        entry.previous &&
        (await hashFile(entry.target)) !==
          (await hashFile(path.join(directory, entry.previous)))
      )
        throw new Error("cloud_save_local_state_changed");
      if (!entry.existed && fs.existsSync(entry.target))
        throw new Error("cloud_save_local_state_changed");
    }
    journal.phase = "applying";
    await saveJournal(directory, journal);
    for (const entry of journal.entries) {
      await guard();
      await assertSafeTarget(entry.target, entry.root);
      if (entry.source) {
        await fs.promises.mkdir(path.dirname(entry.target), {
          recursive: true,
        });
        const temporary = `${entry.target}.${randomUUID()}.restore`;
        try {
          await copyVerified(entry.source, temporary, entry.hash);
          if (entry.lastModifiedAt) {
            const time = new Date(entry.lastModifiedAt);
            await fs.promises.utimes(temporary, time, time);
          }
          if (entry.previousMode !== undefined)
            await fs.promises.chmod(temporary, entry.previousMode & 0o777);
          await fs.promises.rename(temporary, entry.target);
        } finally {
          await fs.promises.rm(temporary, { force: true });
        }
      } else {
        await fs.promises.rm(entry.target, { force: true });
      }
    }
    for (const entry of journal.entries) {
      if (
        entry.source
          ? (await hashFile(entry.target)) !== entry.hash
          : fs.existsSync(entry.target)
      )
        throw new Error("cloud_save_restore_failed");
    }
    await guard();
    journal.phase = "complete";
    await saveJournal(directory, journal);
    await fs.promises.rm(directory, { recursive: true, force: true });
  } catch (error) {
    if (journal.phase === "applying") await rollback(directory, journal);
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const activeTransactions = new Set<string>();
async function exclusive<T>(
  key: string,
  root: string,
  operation: () => Promise<T>
) {
  const scope = JSON.stringify([path.resolve(root), key]);
  if (activeTransactions.has(scope))
    throw new Error("cloud_save_operation_active");
  activeTransactions.add(scope);
  try {
    return await operation();
  } finally {
    activeTransactions.delete(scope);
  }
}
export const recoverRestores = (
  key: string,
  guard: () => Promise<void>,
  root: string
) => exclusive(key, root, () => recoverRestoresUnlocked(key, guard, root));
export const restoreTransaction = (
  key: string,
  changes: RestoreChange[],
  guard: () => Promise<void>,
  root: string
) =>
  exclusive(key, root, () =>
    restoreTransactionUnlocked(key, changes, guard, root)
  );
