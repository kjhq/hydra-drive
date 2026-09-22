import type { GameShop } from "@types";
import { pcIdentity } from "../google-drive/pc-saves";
import { DriveSaveStore } from "../google-drive/store";
import { setCloudSaveAutomaticSyncEnabled } from "./automatic-sync-settings";
import {
  cloudSaveOperationGate,
  cloudSaveOperationScopeKey,
} from "./operation-gate";
import { clearCloudSaveSyncAnchors } from "./sync-anchor";
export const deleteGameCloudSaveData = async (
  objectId: string,
  shop: GameShop,
  assertGameNotRunning: () => void
) =>
  cloudSaveOperationGate.runDeletion(
    cloudSaveOperationScopeKey(objectId, shop),
    "delete-drive-backups",
    async () => {
      assertGameNotRunning();
      await setCloudSaveAutomaticSyncEnabled(objectId, shop, false);
      await new DriveSaveStore().deleteAll(pcIdentity(objectId, shop));
      await clearCloudSaveSyncAnchors(shop, objectId);
    }
  );
