import {
  cloudSaveCustomPathsSublevel,
  cloudSaveLocalHashCacheSublevel,
  cloudSaveSyncAnchorsSublevel,
  db,
  levelKeys,
} from "@main/level";
import type { GameShop } from "@types";
import { GoogleDriveAuth } from "../google-drive/auth";

import { isCloudSaveSyncAnchorKeyForGame } from "./sync-anchor-key";

const getCurrentUserId = async () => `google:${GoogleDriveAuth.accountId()}`;

export const clearCloudSaveLocalState = async (
  objectId: string,
  shop: GameShop,
  customPathStorageKey: string
) => {
  const userId = await getCurrentUserId();
  const cacheKey = levelKeys.game(shop, objectId);
  const anchorKeys: string[] = [];
  for await (const [key] of cloudSaveSyncAnchorsSublevel.iterator()) {
    if (isCloudSaveSyncAnchorKeyForGame(key, userId, shop, objectId)) {
      anchorKeys.push(key);
    }
  }

  const batch = db.batch();
  batch.del(customPathStorageKey, {
    sublevel: cloudSaveCustomPathsSublevel,
  });
  batch.del(cacheKey, {
    sublevel: cloudSaveLocalHashCacheSublevel,
  });
  for (const anchorKey of anchorKeys) {
    batch.del(anchorKey, {
      sublevel: cloudSaveSyncAnchorsSublevel,
    });
  }
  await batch.write();
};
