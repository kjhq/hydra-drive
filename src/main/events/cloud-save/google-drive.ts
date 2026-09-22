import { buildLocalGameSnapshotContext } from "@main/services/cloud-save/build-local-game-snapshot";
import { createRemoteSnapshotFromLocalState } from "@main/services/cloud-save/create-remote-snapshot-from-local-state";
import {
  cloudSaveOperationGate,
  cloudSaveOperationScopeKey,
} from "@main/services/cloud-save/operation-gate";
import { restoreRemoteSnapshot } from "@main/services/cloud-save/restore-remote-snapshot";
import { getCloudSaveSyncAnchor } from "@main/services/cloud-save/sync-anchor";
import { isGameRunning } from "@main/services/game-running-state";
import { pack } from "@main/services/google-drive/archive";
import { GoogleDriveAuth } from "@main/services/google-drive/auth";
import { DriveError } from "@main/services/google-drive/errors";
import { heads } from "@main/services/google-drive/model";
import { legacyArtifacts } from "@main/services/google-drive/opaque-saves";
import {
  promotePCSnapshot,
  summary,
} from "@main/services/google-drive/pc-saves";
import {
  answerDrivePrompt,
  currentDrivePrompt,
} from "@main/services/google-drive/prompt";
import { DriveSaveStore } from "@main/services/google-drive/store";
import type { DriveSaveIdentity, GameShop } from "@types";
import { app, dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import { registerEvent } from "../register-event";

registerEvent("getGoogleDriveConnection", () => GoogleDriveAuth.status());
registerEvent("connectGoogleDrive", () => GoogleDriveAuth.connect());
registerEvent("disconnectGoogleDrive", () => GoogleDriveAuth.disconnect());
registerEvent("getDriveBackupHistory", (_event, identity: DriveSaveIdentity) =>
  new DriveSaveStore().history(identity)
);
registerEvent("getDriveSaveQueue", () => new DriveSaveStore().queue());
registerEvent("getGameArtifacts", (_event, objectId: string, shop: GameShop) =>
  legacyArtifacts(objectId, shop)
);
registerEvent(
  "updateDriveBackup",
  (_event, id: string, values: { label?: string; pinned?: boolean }) =>
    new DriveSaveStore().annotate(id, values)
);
registerEvent("deleteDriveBackup", (_event, id: string) =>
  new DriveSaveStore().deleteBackup(id)
);
registerEvent("exportDriveBackup", async (_event, id: string) => {
  const store = new DriveSaveStore(),
    record = await store.record(id);
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: `save-${record.id}.tar.gz`,
    filters: [{ name: "Save archive", extensions: ["tar.gz"] }],
  });
  if (canceled || !filePath) return;
  const directory = await fs.promises.mkdtemp(
    path.join(app.getPath("temp"), "drive-export-")
  );
  try {
    const content = path.join(directory, "snapshot");
    await fs.promises.mkdir(content);
    await store.download(record, path.join(content, "payload.tar.gz"));
    await fs.promises.writeFile(
      path.join(content, "commit.json"),
      JSON.stringify(record, null, 2)
    );
    const temporary = path.join(directory, "export.tar.gz");
    await pack(content, temporary);
    await fs.promises.copyFile(temporary, filePath);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
registerEvent(
  "restoreDriveBackup",
  async (_event, id: string, expectedHeads: string[]) => {
    const store = new DriveSaveStore(),
      record = await store.record(id);
    if (record.identity.kind !== "pc")
      throw new DriveError("drive_invalid_backup");
    const { objectId } = record.identity,
      shop = record.identity.shop as GameShop;
    return cloudSaveOperationGate.runSync(
      cloudSaveOperationScopeKey(objectId, shop),
      "restore-drive-history",
      async () => {
        if (isGameRunning(objectId, shop))
          throw new Error("cloud_save_game_running");
        const observed = heads(await store.records(record.identity))
          .map((c) => c.id)
          .sort();
        if (
          JSON.stringify(observed) !== JSON.stringify([...expectedHeads].sort())
        )
          throw new DriveError("drive_conflict");
        const directory = await fs.promises.mkdtemp(
          path.join(app.getPath("temp"), "drive-history-restore-")
        );
        try {
          const stagedArchive = path.join(directory, "selected.tar.gz");
          await store.download(record, stagedArchive);
          const local = await buildLocalGameSnapshotContext(objectId, shop);
          const anchor = await getCloudSaveSyncAnchor(
            shop,
            objectId,
            local.environmentId
          );
          const preserved = local.files.length
            ? await createRemoteSnapshotFromLocalState(
                objectId,
                shop,
                undefined,
                local,
                {
                  baseVersion: 1,
                  parentIds: anchor ? [anchor.baseSnapshotId] : [],
                  updateAnchor: false,
                }
              )
            : null;
          const after = heads(await store.records(record.identity)).map(
            (c) => c.id
          );
          if (
            after.some(
              (head) => !observed.includes(head) && head !== preserved?.id
            )
          )
            throw new DriveError("drive_conflict");
          const promoted = summary(
            await promotePCSnapshot(id, after, stagedArchive)
          );
          return await restoreRemoteSnapshot(
            promoted.id,
            { objectId, shop },
            undefined,
            promoted,
            undefined,
            undefined,
            true,
            [],
            0,
            undefined,
            local.aggregateHash
          );
        } finally {
          await fs.promises.rm(directory, { recursive: true, force: true });
        }
      }
    );
  }
);

let draining = false;
export async function retryDriveQueue() {
  if (draining || !GoogleDriveAuth.isConnected()) return;
  draining = true;
  try {
    await GoogleDriveAuth.withSession(async () => {
      const store = new DriveSaveStore();
      for (const pending of await store.queue()) {
        if (pending.status === "conflict") continue;
        const { shop, objectId } = pending.identity;
        if (isGameRunning(objectId, shop as GameShop)) continue;
        try {
          await cloudSaveOperationGate.runSync(
            cloudSaveOperationScopeKey(objectId, shop as GameShop),
            "drive-queue",
            () => store.publishQueued(pending.id)
          );
        } catch (error) {
          if (
            error instanceof DriveError &&
            [
              "drive_offline",
              "drive_account_changed",
              "drive_reconnect_required",
            ].includes(error.code)
          )
            break;
        }
      }
    });
  } finally {
    draining = false;
  }
}
registerEvent("retryDriveSaveQueue", retryDriveQueue);
app.whenReady().then(() => {
  setInterval(() => {
    void retryDriveQueue().catch(() => undefined);
  }, 60_000).unref();
});

registerEvent("getDrivePrompt", (event) => currentDrivePrompt(event.sender.id));
registerEvent("answerDrivePrompt", (event, id: string, accepted: boolean) =>
  answerDrivePrompt(event.sender.id, id, accepted)
);
