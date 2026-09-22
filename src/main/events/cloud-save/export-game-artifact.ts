import { logger, SevenZip, WindowManager } from "@main/services";
import { extractLegacyArchive } from "@main/services/google-drive/archive";
import { downloadOpaque } from "@main/services/google-drive/opaque-saves";
import { DriveSaveStore } from "@main/services/google-drive/store";
import type { LegacySaveExportProgress, LegacySaveExportResult } from "@types";
import { app, BrowserWindow, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { registerEvent } from "../register-event";
import {
  exportGameArtifactArchive,
  sanitizeLegacySaveArchiveName,
} from "./export-game-artifact-operation";
import { gameArtifactExportCoordinator } from "./game-artifact-export-coordinator";

const exportGameArtifact = async (
  event: Electron.IpcMainInvokeEvent,
  operationId: string,
  gameArtifactId: string,
  suggestedName: string
): Promise<LegacySaveExportResult> => {
  if (!operationId)
    throw new Error("Legacy save export operation ID is required");

  const senderWindow =
    BrowserWindow.fromWebContents(event.sender) ??
    WindowManager.mainWindow ??
    null;

  if (!senderWindow) {
    throw new Error("Unable to open the legacy save export dialog");
  }

  const archiveName = sanitizeLegacySaveArchiveName(suggestedName);
  const abortController = gameArtifactExportCoordinator.start(event.sender.id);

  if (!abortController) return { status: "busy" };

  const { signal } = abortController;
  const sendProgress = (progress: LegacySaveExportProgress) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send("on-game-artifact-export-progress", {
        operationId,
        ...progress,
      });
    }
  };

  try {
    return await exportGameArtifactArchive({
      signal,
      createTemporaryDirectory: () =>
        fs.promises.mkdtemp(
          path.join(app.getPath("temp"), "hydra-legacy-save-")
        ),
      downloadTar: async (destinationPath) => {
        const record = await new DriveSaveStore().record(gameArtifactId);
        if (record.identity.kind !== "legacy")
          throw new Error("drive_invalid_backup");
        await downloadOpaque(record, destinationPath, signal);
        sendProgress({
          downloadedBytes: record.archiveSize,
          totalBytes: record.archiveSize,
          percentage: 100,
        });
      },
      extractTar: (tarPath, destinationPath) =>
        extractLegacyArchive(tarPath, destinationPath),
      createZip: (sourcePath, destinationPath) =>
        SevenZip.createZip({ sourcePath, destinationPath, signal }),
      selectDestination: async () => {
        const result = await dialog.showSaveDialog(senderWindow, {
          defaultPath: path.join(
            app.getPath("downloads"),
            `${archiveName}.zip`
          ),
          filters: [{ name: "ZIP archive", extensions: ["zip"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });

        return result.canceled ? null : (result.filePath ?? null);
      },
      copyZip: (sourcePath, destinationPath) =>
        fs.promises.copyFile(sourcePath, destinationPath),
      cleanupTemporaryDirectory: async (temporaryDirectory) => {
        try {
          await fs.promises.rm(temporaryDirectory, {
            recursive: true,
            force: true,
          });
        } catch (error) {
          logger.error(
            "Failed to clean up legacy save export temporary files",
            error
          );
        }
      },
    });
  } catch (error) {
    if (signal.aborted) return { status: "cancelled" };

    logger.error("Failed to export legacy save", error);
    throw error;
  } finally {
    gameArtifactExportCoordinator.finish(abortController);
  }
};

const cancelGameArtifactExport = (event: Electron.IpcMainInvokeEvent) =>
  gameArtifactExportCoordinator.cancel(event.sender.id);

registerEvent("exportGameArtifact", exportGameArtifact);
registerEvent("cancelGameArtifactExport", cancelGameArtifactExport);
