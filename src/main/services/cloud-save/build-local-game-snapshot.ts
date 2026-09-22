import { cloudSaveLocalHashCacheSublevel, levelKeys } from "@main/level";
import { SystemPath } from "@main/services/system-path";
import type {
  CloudSaveCustomPathBindings,
  GameShop,
  LocalGameSnapshotContext,
} from "@types";
import { isGameRunning } from "../game-running-state";
import { recoverRestores } from "../google-drive/restore-runtime";

import { NativeAddon } from "../native-addon";
import { getCloudSaveGameContext } from "./cloud-save-game-context";
import { getUsableCloudSaveCustomPathBindings } from "./custom-path-overlap";
import { customPathToCloudSaveRule } from "./custom-path-store";

interface BuildLocalGameSnapshotContextOptions {
  customPathBindings?: CloudSaveCustomPathBindings;
}

export const buildLocalGameSnapshotContext = async (
  objectId: string,
  shop: GameShop,
  suppliedContext?: Awaited<ReturnType<typeof getCloudSaveGameContext>>,
  options: BuildLocalGameSnapshotContextOptions = {}
): Promise<LocalGameSnapshotContext> => {
  await recoverRestores(JSON.stringify([shop, objectId]), async () => {
    if (isGameRunning(objectId, shop))
      throw new Error("cloud_save_game_running");
  });
  const context =
    suppliedContext ?? (await getCloudSaveGameContext(objectId, shop));
  const { game, pathContext, environmentId } = context;
  const cacheKey = levelKeys.game(shop, objectId);
  const [hashCache, customPathBindings] = await Promise.all([
    cloudSaveLocalHashCacheSublevel.get(cacheKey).then((value) => value ?? []),
    options.customPathBindings
      ? Promise.resolve(options.customPathBindings)
      : getUsableCloudSaveCustomPathBindings(objectId, shop, context),
  ]);
  const extraRules = customPathBindings.ready.map(customPathToCloudSaveRule);
  const customPathRawPaths = customPathBindings.ready
    .map(({ rawPath }) => rawPath)
    .sort((left, right) => left.localeCompare(right));
  const { hashCache: updatedHashCache, ...snapshot } =
    await NativeAddon.buildLocalGameSnapshotPipeline({
      ...pathContext,
      environmentId,
      title: game?.title,
      remoteId: game?.remoteId ?? undefined,
      userDataPath: SystemPath.getPath("userData"),
      hashCache,
      extraRules,
    });

  if (updatedHashCache.length === 0) {
    await cloudSaveLocalHashCacheSublevel.del(cacheKey);
  } else {
    await cloudSaveLocalHashCacheSublevel.put(cacheKey, updatedHashCache);
  }

  return { ...snapshot, environmentId, pathContext, customPathRawPaths };
};
