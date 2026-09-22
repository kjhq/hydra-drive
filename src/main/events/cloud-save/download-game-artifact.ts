import { publicProfilePath } from "@main/constants";
import { CloudSync, WindowManager, Wine } from "@main/services";
import {
  cloudSaveOperationGate,
  cloudSaveOperationScopeKey,
} from "@main/services/cloud-save/operation-gate";
import { isGameRunning } from "@main/services/game-running-state";
import {
  extractLegacyArchive,
  hashFile,
  safeArchivePath,
} from "@main/services/google-drive/archive";
import { GoogleDriveAuth } from "@main/services/google-drive/auth";
import { heads } from "@main/services/google-drive/model";
import {
  confirmOpaqueRestore,
  finishOpaqueRestore,
} from "@main/services/google-drive/opaque-saves";
import {
  restoreTransaction,
  type RestoreChange,
} from "@main/services/google-drive/restore-runtime";
import { DriveSaveStore } from "@main/services/google-drive/store";
import type { GameShop, LudusaviBackupMapping } from "@types";
import fs from "node:fs";
import path from "node:path";
import { registerEvent } from "../register-event";

import { addTrailingSlash } from "@main/helpers";
import { gamesSublevel, levelKeys } from "@main/level";
import { SystemPath } from "@main/services/system-path";
import YAML from "yaml";
import { downloadGameArtifactPayload } from "./game-artifact-download";

export const transformLudusaviBackupPathIntoWindowsPath = (
  backupPath: string,
  winePrefixPath?: string | null
) => {
  return backupPath
    .replace(winePrefixPath ? addTrailingSlash(winePrefixPath) : "", "")
    .replace("drive_c", "C:");
};

export const addWinePrefixToWindowsPath = (
  windowsPath: string,
  winePrefixPath?: string | null
) => {
  if (!winePrefixPath) {
    return windowsPath;
  }

  return path.join(winePrefixPath, windowsPath.replace("C:", "drive_c"));
};

const downloadGameArtifact = async (
  _event: Electron.IpcMainInvokeEvent,
  objectId: string,
  shop: GameShop,
  gameArtifactId: string
) => {
  const session = GoogleDriveAuth.session();
  const guard = async () => {
    GoogleDriveAuth.assert(session);
    if (isGameRunning(objectId, shop))
      throw new Error("cloud_save_game_running");
  };
  await guard();
  const directory = await fs.promises.mkdtemp(
    path.join(SystemPath.getPath("temp"), "drive-legacy-restore-")
  );
  try {
    const game = await gamesSublevel.get(levelKeys.game(shop, objectId));
    const prefix = Wine.getEffectivePrefixPath(game?.winePrefixPath, objectId);
    const selection = await confirmOpaqueRestore(gameArtifactId);
    const archive = path.join(directory, "backup.tar");
    const commit = await downloadGameArtifactPayload(gameArtifactId, archive);
    const preserved = await CloudSync.uploadSaveGame(
      objectId,
      shop,
      null,
      "Before restoring another snapshot"
    );
    const expected = heads(
      await new DriveSaveStore().records(selection.commit.identity)
    ).map((c) => c.id);
    if (
      expected.some(
        (id) => !selection.expected.includes(id) && id !== preserved.id
      )
    )
      throw new Error("drive_conflict");
    if (commit.identity.shop !== shop || commit.identity.objectId !== objectId)
      throw new Error("drive_invalid_backup");
    const content = path.join(directory, "content");
    await extractLegacyArchive(archive, content);
    if (!safeArchivePath(objectId) || objectId.includes("/"))
      throw new Error("drive_invalid_backup");
    const gameBackupPath = path.join(content, objectId);
    const mapping = YAML.parse(
      await fs.promises.readFile(
        path.join(gameBackupPath, "mapping.yaml"),
        "utf8"
      )
    ) as { backups: LudusaviBackupMapping[]; drives: Record<string, string> };
    const home = String(commit.metadata.homeDir ?? "");
    if (!home) throw new Error("drive_invalid_backup");
    const changes: RestoreChange[] = [];
    const roots = [
      SystemPath.getPath("home"),
      SystemPath.getPath("documents"),
      SystemPath.getPath("appData"),
      prefix,
      game?.executablePath ? path.dirname(game.executablePath) : null,
    ].filter((root): root is string => Boolean(root));
    for (const backup of mapping.backups)
      for (const original of Object.keys(backup.files)) {
        const sourceName = Object.entries(mapping.drives).reduce(
          (value, [key, drive]) => value.replace(drive, key),
          original
        );
        const source = path.join(gameBackupPath, sourceName);
        if (path.relative(gameBackupPath, source).startsWith(".."))
          throw new Error("drive_invalid_backup");
        const target = transformLudusaviBackupPathIntoWindowsPath(
          original,
          commit.metadata.winePrefixPath as string | null
        )
          .replace(
            home,
            addWinePrefixToWindowsPath(
              CloudSync.getWindowsLikeUserProfilePath(prefix),
              prefix
            )
          )
          .replace(
            publicProfilePath,
            addWinePrefixToWindowsPath(publicProfilePath, prefix)
          );
        const root = roots.find((root) => {
          const relative = path.relative(root, target);
          return (
            relative && !relative.startsWith("..") && !path.isAbsolute(relative)
          );
        });
        if (!root) throw new Error("cloud_save_restore_paths_unresolved");
        changes.push({ target, root, source, hash: await hashFile(source) });
      }
    await restoreTransaction(JSON.stringify([shop, objectId]), changes, guard);
    await finishOpaqueRestore(gameArtifactId, expected, archive);
    WindowManager.sendToAppWindows(
      `on-backup-download-complete-${objectId}-${shop}`,
      true
    );
  } catch (error) {
    WindowManager.sendToAppWindows(
      `on-backup-download-complete-${objectId}-${shop}`,
      false
    );
    throw error;
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};
registerEvent(
  "downloadGameArtifact",
  (event, objectId: string, shop: GameShop, id: string) =>
    cloudSaveOperationGate.runSync(
      cloudSaveOperationScopeKey(objectId, shop),
      "restore-legacy",
      () => downloadGameArtifact(event, objectId, shop, id)
    )
);
