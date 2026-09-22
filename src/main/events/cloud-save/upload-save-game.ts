import { CloudSync } from "@main/services";
import {
  cloudSaveOperationGate,
  cloudSaveOperationScopeKey,
} from "@main/services/cloud-save/operation-gate";
import type { GameShop } from "@types";
import { registerEvent } from "../register-event";

const uploadSaveGame = async (
  _event: Electron.IpcMainInvokeEvent,
  objectId: string,
  shop: GameShop,
  downloadOptionTitle: string | null
) => {
  return cloudSaveOperationGate.runSync(
    cloudSaveOperationScopeKey(objectId, shop),
    "upload-legacy",
    () =>
      CloudSync.uploadSaveGame(
        objectId,
        shop,
        downloadOptionTitle,
        CloudSync.getBackupLabel(false)
      )
  );
};

registerEvent("uploadSaveGame", uploadSaveGame);
