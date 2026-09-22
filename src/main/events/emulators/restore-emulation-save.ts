import {
  copyVerified,
  hashFile,
  safeArchivePath,
} from "@main/services/google-drive/archive";
import { GoogleDriveAuth } from "@main/services/google-drive/auth";
import {
  assertEmulatorsStopped,
  withEmulatorSaveLock,
} from "@main/services/google-drive/emulator-restore-guard";
import { heads, type DriveCommit } from "@main/services/google-drive/model";
import {
  confirmOpaqueRestore,
  finishOpaqueRestore,
  publishOpaque,
} from "@main/services/google-drive/opaque-saves";
import {
  restoreTransaction,
  type RestoreChange,
} from "@main/services/google-drive/restore-runtime";
import { DriveSaveStore } from "@main/services/google-drive/store";
import { app, shell } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { emulators, logger } from "@main/services";
import { SevenZip } from "@main/services/7zip";
import type {
  EmulationSaveMetadata,
  EmulationSavePlatform,
  MemcardRestoreResult,
  MemcardRestoreTarget,
} from "@types";
import { getDownloadsPath } from "../helpers/get-downloads-path";
import { registerEvent } from "../register-event";

type EmulationSaveMetadataInput =
  | EmulationSaveMetadata
  | Record<string, unknown>
  | null;

const isPspMetadata = (
  metadata: EmulationSaveMetadataInput
): metadata is Extract<
  EmulationSaveMetadata,
  { artifactFormat: "ppsspp-savedata-zip" }
> =>
  metadata?.schemaVersion === 1 &&
  metadata.artifactFormat === "ppsspp-savedata-zip" &&
  typeof metadata.discId === "string" &&
  /^[A-Za-z]{4}\d{5}$/.test(metadata.discId) &&
  typeof metadata.savedataDirectory === "string" &&
  metadata.savedataDirectory !== "." &&
  metadata.savedataDirectory !== ".." &&
  /^[^/\\]+$/.test(metadata.savedataDirectory);

const isGamecubeMetadata = (
  metadata: EmulationSaveMetadataInput
): metadata is Extract<
  EmulationSaveMetadata,
  { artifactFormat: "dolphin-gci" }
> =>
  metadata?.schemaVersion === 1 &&
  metadata.artifactFormat === "dolphin-gci" &&
  typeof metadata.gameId === "string" &&
  /^[A-Za-z0-9]{6}$/.test(metadata.gameId) &&
  typeof metadata.internalFileName === "string" &&
  metadata.internalFileName.length > 0 &&
  metadata.internalFileName !== "." &&
  metadata.internalFileName !== ".." &&
  /^[^/\\]+$/.test(metadata.internalFileName) &&
  (metadata.slot === "A" || metadata.slot === "B") &&
  ["USA", "JPN", "EUR", "KOR", "DEV", "unknown"].includes(
    metadata.region as string
  );

const isWiiMetadata = (
  metadata: EmulationSaveMetadataInput
): metadata is Extract<
  EmulationSaveMetadata,
  { artifactFormat: "dolphin-wii-data-bin" }
> =>
  metadata?.schemaVersion === 1 &&
  metadata.artifactFormat === "dolphin-wii-data-bin" &&
  typeof metadata.titleId === "string" &&
  /^[0-9a-f]{16}$/i.test(metadata.titleId) &&
  (metadata.gameId === undefined ||
    (typeof metadata.gameId === "string" &&
      /^[A-Za-z0-9]{6}$/.test(metadata.gameId)));

const gamecubeRegionDirectory = (region: string): string => {
  if (region === "JPN") return "JAP";
  return ["USA", "EUR", "KOR", "DEV"].includes(region) ? region : "USA";
};

const preferExistingDirectories = (directories: string[]): string[] => {
  const existing = directories.filter((directory) => existsSync(directory));
  return existing.length > 0 ? existing : directories.slice(0, 1);
};

const restoreTargets = async (
  platform: EmulationSavePlatform,
  metadata: EmulationSaveMetadataInput = null
): Promise<MemcardRestoreTarget[]> => {
  const config = await emulators.getEmulatorConfig(
    emulators.emulationSavePlatformToSystem(platform)
  );
  if (!config.executablePath) return [];

  if (platform === "ps1" || platform === "ps2") {
    const files =
      platform === "ps2"
        ? await emulators.resolvePs2MemcardFiles(config.executablePath)
        : await emulators.resolvePs1MemcardFiles(config.executablePath);
    return files.map((cardFilePath) => ({
      cardFilePath,
      cardLabel: path.basename(cardFilePath),
    }));
  }

  if (platform === "psp" && isPspMetadata(metadata)) {
    const directories = await emulators.ppssppSavedataDirectoryCandidates(
      config.executablePath
    );
    return preferExistingDirectories(directories).map((cardFilePath) => ({
      cardFilePath,
      cardLabel: "PPSSPP SAVEDATA",
    }));
  }

  if (platform === "gamecube" && isGamecubeMetadata(metadata)) {
    const region = gamecubeRegionDirectory(metadata.region);
    const directories = emulators
      .dolphinUserDirectoryCandidates(config.executablePath)
      .map((userDirectory) =>
        path.join(userDirectory, "GC", region, `Card ${metadata.slot}`)
      );
    return preferExistingDirectories(directories).map((cardFilePath) => ({
      cardFilePath,
      cardLabel: `${metadata.region} · Card ${metadata.slot}`,
    }));
  }

  if (platform === "wii" && isWiiMetadata(metadata)) {
    const cardFilePath = path.join(await getDownloadsPath(), "Hydra Wii Saves");
    return [{ cardFilePath, cardLabel: "Wii data.bin export" }];
  }

  return [];
};

// Local cards a downloaded save can be written into (for the restore picker).
const getMemcardRestoreTargets = async (
  _event: Electron.IpcMainInvokeEvent,
  platform: EmulationSavePlatform,
  metadata?: EmulationSaveMetadataInput
): Promise<MemcardRestoreTarget[]> => restoreTargets(platform, metadata);

const restorePpssppSave = async (
  bytes: Buffer,
  savedataRoot: string,
  metadata: Extract<
    EmulationSaveMetadata,
    { artifactFormat: "ppsspp-savedata-zip" }
  >
): Promise<void> => {
  await fs.mkdir(savedataRoot, { recursive: true });
  const temporaryRoot = await fs.mkdtemp(
    path.join(savedataRoot, ".hydra-restore-")
  );
  const archivePath = path.join(temporaryRoot, "save.zip");
  const extractionPath = path.join(temporaryRoot, "extracted");
  const stagedPath = path.join(temporaryRoot, "staged");
  const backupPath = path.join(
    path.dirname(savedataRoot),
    "HYDRA_BACKUPS",
    `${metadata.savedataDirectory}-${Date.now()}-${randomUUID()}`
  );
  const targetPath = path.join(savedataRoot, metadata.savedataDirectory);
  let movedExisting = false;

  try {
    await fs.writeFile(archivePath, bytes);
    const entries = await SevenZip.listFiles(archivePath);
    if (
      !emulators.archiveEntriesBelongToDirectory(
        entries,
        metadata.savedataDirectory
      )
    ) {
      throw new Error("The PPSSPP save archive has an invalid layout");
    }
    const listed = await SevenZip.listEntries(archivePath);
    let expanded = 0;
    const names = new Set<string>();
    for (const entry of listed) {
      expanded += entry.size;
      const name = entry.name.replaceAll("\\", "/");
      if (
        !safeArchivePath(name) ||
        names.has(name.toLowerCase()) ||
        entry.encrypted ||
        expanded > 512 * 1024 * 1024
      )
        throw new Error("drive_invalid_backup");
      names.add(name.toLowerCase());
      const destination = path.join(extractionPath, name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const content = await SevenZip.readEntry(
        archivePath,
        entry.name,
        Math.max(1, entry.size)
      );
      if (content.length !== entry.size)
        throw new Error("drive_invalid_backup");
      await fs.writeFile(destination, content, { flag: "wx" });
    }

    const wrappedPath = path.join(extractionPath, metadata.savedataDirectory);
    const wrappedStat = await fs.stat(wrappedPath);
    if (!wrappedStat.isDirectory()) {
      throw new Error("The PPSSPP save archive has no savedata directory");
    }
    const sourcePath = wrappedPath;
    const discId = await emulators.readPpssppSavedataDiscId(sourcePath);
    if (discId !== metadata.discId.toUpperCase()) {
      throw new Error("The PPSSPP save does not match its metadata");
    }
    await fs.cp(sourcePath, stagedPath, { recursive: true });

    if (existsSync(targetPath)) {
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.rename(targetPath, backupPath);
      movedExisting = true;
    }
    await fs.rename(stagedPath, targetPath);
  } catch (error) {
    if (movedExisting) {
      await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
      await fs.rename(backupPath, targetPath).catch(() => {});
    }
    throw error;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
};

const restoreGamecubeSave = async (
  bytes: Buffer,
  targetDirectory: string,
  metadata: Extract<EmulationSaveMetadata, { artifactFormat: "dolphin-gci" }>,
  sourceFileName?: string
): Promise<void> => {
  await fs.mkdir(targetDirectory, { recursive: true });
  const targetFileName =
    sourceFileName &&
    path.basename(sourceFileName) === sourceFileName &&
    sourceFileName.toLowerCase().endsWith(".gci")
      ? sourceFileName
      : `${metadata.gameId}-${metadata.internalFileName.replace(
          /[^A-Za-z0-9._-]/g,
          "_"
        )}.gci`;
  const targetPath = path.join(targetDirectory, targetFileName);
  const temporaryPath = path.join(
    targetDirectory,
    `.hydra-${randomUUID()}.gci`
  );
  const backupPath = `${targetPath}.hydra-backup-${Date.now()}`;
  let backedUp = false;
  try {
    await fs.writeFile(temporaryPath, bytes);
    const gameId = emulators.parseGciGameId(bytes.subarray(0, 6));
    const internalFileName = emulators.parseGciInternalFileName(
      bytes.subarray(0, 0x40)
    );
    if (
      gameId !== metadata.gameId.toUpperCase() ||
      internalFileName !== metadata.internalFileName
    ) {
      throw new Error("The GameCube save does not match its metadata");
    }
    try {
      await fs.copyFile(targetPath, backupPath);
      backedUp = true;
      await fs.unlink(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    if (backedUp) await fs.copyFile(backupPath, targetPath).catch(() => {});
    if (backedUp) await fs.rm(backupPath, { force: true }).catch(() => {});
    throw error;
  }
};

const restoreWiiSaveExport = async (
  bytes: Buffer,
  targetDirectory: string,
  metadata: Extract<
    EmulationSaveMetadata,
    { artifactFormat: "dolphin-wii-data-bin" }
  >
): Promise<string> => {
  const gameCode = Buffer.from(metadata.titleId.slice(8), "hex").toString(
    "ascii"
  );
  if (!/^[A-Za-z0-9]{4}$/.test(gameCode)) {
    throw new Error("Invalid Wii save title ID");
  }

  await fs.mkdir(targetDirectory, { recursive: true });
  const exportRoot = await fs.mkdtemp(
    path.join(targetDirectory, `${metadata.titleId}-`)
  );
  const outputPath = path.join(
    exportRoot,
    "private",
    "wii",
    "title",
    gameCode,
    "data.bin"
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes, { flag: "wx" });
  shell.showItemInFolder(outputPath);
  return outputPath;
};

const assertValidRestoreDestination = async (
  platform: EmulationSavePlatform,
  metadata: EmulationSaveMetadataInput,
  targetCardFilePath: string
): Promise<void> => {
  // PS1/PS2 also support a card selected explicitly in the file picker.
  // Conversion validates the existing card before the staged copy is installed.
  if (platform === "ps1" || platform === "ps2") {
    if (!path.isAbsolute(targetCardFilePath))
      throw new Error("Invalid memory card path");
    return;
  }
  const allowedTargets = await restoreTargets(platform, metadata);
  const isAllowed = allowedTargets.some(
    (target) => target.cardFilePath === targetCardFilePath
  );
  if (!isAllowed) {
    throw new Error("Invalid emulator save restore destination");
  }
};

const restoreFileSave = async (
  platform: EmulationSavePlatform,
  bytes: Buffer,
  targetCardFilePath: string,
  metadata: EmulationSaveMetadataInput,
  sourceFileName?: string
): Promise<MemcardRestoreResult | null> => {
  if (platform === "psp") {
    if (!isPspMetadata(metadata)) {
      throw new Error("Invalid PPSSPP save metadata");
    }
    await restorePpssppSave(bytes, targetCardFilePath, metadata);
    return { ok: true };
  }

  if (platform === "gamecube") {
    if (!isGamecubeMetadata(metadata)) {
      throw new Error("Invalid GameCube save metadata");
    }
    await restoreGamecubeSave(
      bytes,
      targetCardFilePath,
      metadata,
      sourceFileName
    );
    return { ok: true };
  }

  if (platform === "wii") {
    if (!isWiiMetadata(metadata)) {
      throw new Error("Invalid Wii save metadata");
    }
    const location = await restoreWiiSaveExport(
      bytes,
      targetCardFilePath,
      metadata
    );
    return { ok: true, reason: "manual-import-required", location };
  }

  return null;
};

const restoreMemoryCardSave = async (
  platform: EmulationSavePlatform,
  bytes: Buffer,
  targetCardFilePath: string,
  saveId: string
): Promise<MemcardRestoreResult> => {
  const result =
    platform === "ps2"
      ? await emulators.importPsuIntoCard(targetCardFilePath, bytes)
      : await emulators.importMcsIntoCard(targetCardFilePath, bytes);
  if (!result.ok) {
    logger.error(
      "Failed to restore emulation save",
      { platform, saveId, targetCardFilePath, reason: result.reason },
      result.error
    );
  }
  return { ok: result.ok, error: result.error, reason: result.reason };
};

async function preserveLocalSave(
  commit: DriveCommit,
  platform: EmulationSavePlatform,
  target: string,
  metadata: EmulationSaveMetadataInput,
  sourceFileName?: string
) {
  const directory = await fs.mkdtemp(
    path.join(app.getPath("temp"), "drive-preserve-emulator-")
  );
  try {
    let buffer: Buffer | undefined;
    const identity = String(commit.metadata.saveIdentity ?? "");
    if (platform === "ps2") {
      const contents = await emulators.readSaveContents(target, identity);
      if (contents) buffer = emulators.buildPsuBuffer(contents);
    } else if (platform === "ps1") {
      const contents = await emulators.readPs1SaveContents(target, identity);
      if (contents) buffer = emulators.buildMcsBuffer(contents);
    } else if (platform === "gamecube" && isGamecubeMetadata(metadata)) {
      const name =
        sourceFileName &&
        path.basename(sourceFileName) === sourceFileName &&
        sourceFileName.toLowerCase().endsWith(".gci")
          ? sourceFileName
          : `${metadata.gameId}-${metadata.internalFileName.replace(/[^A-Za-z0-9._-]/g, "_")}.gci`;
      buffer = await fs.readFile(path.join(target, name)).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    } else if (platform === "psp" && isPspMetadata(metadata)) {
      const local = path.join(target, metadata.savedataDirectory);
      if (existsSync(local)) {
        const staging = path.join(directory, "local");
        await fs.mkdir(staging);
        await fs.cp(local, path.join(staging, metadata.savedataDirectory), {
          recursive: true,
          filter: async (file) => {
            if ((await fs.lstat(file)).isSymbolicLink())
              throw new Error("drive_invalid_backup");
            return true;
          },
        });
        const zip = path.join(directory, "local.zip");
        await SevenZip.createZip({ sourcePath: staging, destinationPath: zip });
        buffer = await fs.readFile(zip);
      }
    }
    if (!buffer) return null;
    const source = path.join(directory, "save");
    await fs.writeFile(source, buffer);
    return await publishOpaque(
      commit.identity,
      source,
      "Before restoring another snapshot",
      commit.metadata
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

// Download the cloud save and write it back into the chosen local card.
const restoreEmulationSave = async (
  _event: Electron.IpcMainInvokeEvent,
  platform: EmulationSavePlatform,
  saveId: string,
  targetCardFilePath: string,
  metadata: EmulationSaveMetadataInput = null,
  sourceFileName?: string
): Promise<MemcardRestoreResult> => {
  try {
    return await withEmulatorSaveLock(async () => {
      const session = GoogleDriveAuth.session();
      const guard = async () => {
        GoogleDriveAuth.assert(session);
        await assertEmulatorsStopped();
      };
      await guard();
      const selection = await confirmOpaqueRestore(saveId);
      if (
        selection.commit.identity.kind !== "emulator" ||
        selection.commit.metadata.platform !== platform
      )
        throw new Error("drive_invalid_backup");
      metadata = (selection.commit.metadata.metadata ??
        null) as EmulationSaveMetadataInput;
      sourceFileName = String(selection.commit.metadata.fileName ?? "");
      await assertValidRestoreDestination(
        platform,
        metadata,
        targetCardFilePath
      );
      await guard();
      const bytes = await emulators.downloadEmulationSaveBytes(saveId);
      const preserved = await preserveLocalSave(
        selection.commit,
        platform,
        targetCardFilePath,
        metadata,
        sourceFileName
      );
      const expected = heads(
        await new DriveSaveStore().records(selection.commit.identity)
      ).map((c) => c.id);
      if (
        expected.some(
          (id) => !selection.expected.includes(id) && id !== preserved?.id
        )
      )
        throw new Error("drive_conflict");
      await guard();
      if (platform === "wii")
        return (await restoreFileSave(
          platform,
          bytes,
          targetCardFilePath,
          metadata,
          sourceFileName
        ))!;
      const directory = await fs.mkdtemp(
        path.join(app.getPath("temp"), "drive-emulator-stage-")
      );
      try {
        if (platform === "ps1" || platform === "ps2") {
          const staged = path.join(
            directory,
            path.basename(targetCardFilePath)
          );
          await copyVerified(targetCardFilePath, staged);
          const result = await restoreMemoryCardSave(
            platform,
            bytes,
            staged,
            saveId
          );
          if (!result.ok) return result;
          await restoreTransaction(
            "emulator",
            [
              {
                target: targetCardFilePath,
                root: path.dirname(targetCardFilePath),
                source: staged,
                hash: await hashFile(staged),
              },
            ],
            guard
          );
          await finishOpaqueRestore(saveId, expected, bytes);
          return result;
        }
        const stagedRoot = path.join(directory, "staged");
        const result = await restoreFileSave(
          platform,
          bytes,
          stagedRoot,
          metadata,
          sourceFileName
        );
        if (!result) throw new Error("drive_invalid_backup");
        const changes: RestoreChange[] = [];
        const collect = async (root: string, relative = ""): Promise<void> => {
          for (const entry of await fs.readdir(path.join(root, relative), {
            withFileTypes: true,
          })) {
            if (entry.isSymbolicLink()) throw new Error("drive_invalid_backup");
            const name = path.join(relative, entry.name);
            if (entry.isDirectory()) await collect(root, name);
            else if (entry.isFile())
              changes.push({
                target: path.join(targetCardFilePath, name),
                root: targetCardFilePath,
                source: path.join(root, name),
                hash: await hashFile(path.join(root, name)),
              });
            else throw new Error("drive_invalid_backup");
          }
        };
        await collect(stagedRoot);
        if (platform === "psp" && isPspMetadata(metadata)) {
          const existing = path.join(
            targetCardFilePath,
            metadata.savedataDirectory
          );
          const removed = async (root: string): Promise<void> => {
            for (const entry of await fs
              .readdir(root, { withFileTypes: true })
              .catch((error) => {
                if (error.code === "ENOENT") return [];
                throw error;
              })) {
              const target = path.join(root, entry.name);
              if (entry.isSymbolicLink())
                throw new Error("drive_invalid_backup");
              if (entry.isDirectory()) await removed(target);
              else if (!changes.some((change) => change.target === target))
                changes.push({ target, root: targetCardFilePath });
            }
          };
          await removed(existing);
        }
        await restoreTransaction("emulator", changes, guard);
        await finishOpaqueRestore(saveId, expected, bytes);
        return result;
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  } catch (err) {
    logger.error("Failed to restore emulation save", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};

registerEvent("getMemcardRestoreTargets", getMemcardRestoreTargets);
registerEvent("restoreEmulationSave", restoreEmulationSave);
