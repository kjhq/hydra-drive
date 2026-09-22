import type { GameShop } from "@types";
import { heads } from "../google-drive/model";
import { pcIdentity, summary } from "../google-drive/pc-saves";
import { DriveSaveStore } from "../google-drive/store";

export const listRemoteGameSnapshots = async (
  objectId: string,
  shop: GameShop
) =>
  heads(await new DriveSaveStore().records(pcIdentity(objectId, shop)))
    .filter((c) => !c.deleted)
    .map(summary);
