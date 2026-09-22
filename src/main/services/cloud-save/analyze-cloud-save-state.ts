import { logger } from "@main/services/logger";
import type {
  CloudSaveCustomPathBindings,
  CloudSaveState,
  GameShop,
} from "@types";
import { isGameRunning } from "../game-running-state";
import { decideSync, heads } from "../google-drive/model";
import { pcIdentity, summary } from "../google-drive/pc-saves";
import { recoverRestores } from "../google-drive/restore-runtime";
import { DriveSaveStore } from "../google-drive/store";

import { NativeAddon } from "../native-addon";
import { buildLocalGameSnapshotContext } from "./build-local-game-snapshot";
import { cloudSaveFileKey } from "./cloud-save-contract";
import { getCloudSaveGameContext } from "./cloud-save-game-context";
import { cloudSaveCustomPathContextFromPathContext } from "./custom-path";
import { getUsableCloudSaveCustomPathBindings } from "./custom-path-overlap";
import {
  getCloudSaveCustomPathTrackingState,
  reconcileCloudSaveCustomPathsWithRemote,
} from "./custom-path-store";
import { getInstallationOwnedCustomPathRawPaths } from "./installation-owned-custom-paths";
import { mergeUserVariantSnapshots } from "./merge-user-variant-snapshots";
import { reconcileRemoteTargetObservations } from "./reconcile-remote-target-observations";
import {
  getRemoteSnapshotRestoreManifest,
  resolveRestoreManifestTargets,
} from "./resolve-remote-snapshot-targets";
import { getCloudSaveSyncAnchor } from "./sync-anchor";
import type { SyncDirection } from "./sync-game/policy";

interface AnalyzeCloudSaveStateOptions {
  customPathBindings?: CloudSaveCustomPathBindings;
  allowInstallationOwnedCustomPathDeletion?: boolean;
}

const isUnavailableRestoreEnvironment = (error: unknown) =>
  error instanceof Error &&
  (error.message === "cloud_save_restore_prefix_unresolved" ||
    error.message === "cloud_save_restore_prefix_invalid" ||
    error.message === "cloud_save_restore_profile_unresolved");

export const analyzeCloudSaveState = async (
  objectId: string,
  shop: GameShop,
  suppliedContext?: Awaited<ReturnType<typeof getCloudSaveGameContext>>,
  syncDirection: SyncDirection = "bidirectional",
  options: AnalyzeCloudSaveStateOptions = {}
) => {
  await recoverRestores(JSON.stringify([shop, objectId]), async () => {
    if (isGameRunning(objectId, shop))
      throw new Error("cloud_save_game_running");
  });
  const [context, driveRecords] = await Promise.all([
    suppliedContext ?? getCloudSaveGameContext(objectId, shop),
    new DriveSaveStore().records(pcIdentity(objectId, shop)),
  ]);
  const remoteSnapshots = heads(driveRecords)
    .filter((c) => !c.deleted)
    .map(summary);
  const activeRemoteSnapshot = remoteSnapshots[0] ?? null;
  const remoteManifest = activeRemoteSnapshot
    ? await getRemoteSnapshotRestoreManifest(activeRemoteSnapshot)
    : null;
  if (
    remoteManifest &&
    (remoteManifest.snapshot.shop !== shop ||
      remoteManifest.snapshot.objectId !== objectId)
  ) {
    throw new Error("Active Cloud Save snapshot belongs to another game");
  }
  const anchor = await getCloudSaveSyncAnchor(
    shop,
    objectId,
    context.environmentId,
    { allowEnvironmentFallback: !activeRemoteSnapshot }
  );
  const customPathContext = cloudSaveCustomPathContextFromPathContext(
    context.pathContext
  );
  let trackingState: Awaited<
    ReturnType<typeof getCloudSaveCustomPathTrackingState>
  >;
  if (options.customPathBindings) {
    trackingState = {
      bindings: options.customPathBindings,
      pendingRawPaths: [],
    };
  } else if (!remoteManifest && anchor) {
    trackingState = await getCloudSaveCustomPathTrackingState(
      shop,
      objectId,
      customPathContext
    );
  } else {
    trackingState = await reconcileCloudSaveCustomPathsWithRemote(
      shop,
      objectId,
      remoteManifest?.customPathRawPaths ?? [],
      customPathContext
    );
  }
  const customPathBindings = await getUsableCloudSaveCustomPathBindings(
    objectId,
    shop,
    context,
    {
      bindings: trackingState.bindings,
      remoteFiles: remoteManifest?.files ?? [],
    }
  );
  const preserveLocalMissingRawPaths =
    options.allowInstallationOwnedCustomPathDeletion
      ? new Set<string>()
      : await getInstallationOwnedCustomPathRawPaths(
          customPathBindings,
          context.pathContext
        );
  let localSnapshotContext = await buildLocalGameSnapshotContext(
    objectId,
    shop,
    context,
    {
      customPathBindings,
    }
  );

  if (remoteManifest) {
    const localEntryIds = new Set(
      localSnapshotContext.files.map(cloudSaveFileKey)
    );
    const missingRemoteFiles = remoteManifest.files.filter(
      (file) => !localEntryIds.has(cloudSaveFileKey(file))
    );
    if (missingRemoteFiles.length > 0) {
      const usedVariantIds = new Set(
        missingRemoteFiles.map((file) => file.variantId)
      );
      try {
        const resolution = await resolveRestoreManifestTargets(
          {
            ...remoteManifest,
            variants: remoteManifest.variants.filter((variant) =>
              usedVariantIds.has(variant.variantId)
            ),
            files: missingRemoteFiles,
          },
          context.pathContext,
          customPathBindings
        );
        localSnapshotContext = reconcileRemoteTargetObservations(
          localSnapshotContext,
          remoteManifest.variants,
          missingRemoteFiles,
          resolution,
          (input) => NativeAddon.buildSnapshotAggregateHash(input)
        );
      } catch (error) {
        if (!isUnavailableRestoreEnvironment(error)) throw error;
        logger.info(
          "[Cloud Save] Skipping remote target observation without a usable restore environment",
          { shop, objectId, error }
        );
      }
    }
  }

  const {
    sourceFiles: _,
    environmentId,
    pathContext: __,
    ...localSnapshot
  } = localSnapshotContext;
  const merge = mergeUserVariantSnapshots({
    local: localSnapshotContext,
    remoteVariants: remoteManifest?.variants ?? [],
    remoteFiles: remoteManifest?.files ?? [],
    base: anchor,
    direction: syncDirection,
    preserveLocalMissingRawPaths,
    treatLocalAsNewRawPaths: new Set(trackingState.pendingRawPaths),
  });
  const mergedCustomPathRawPaths = [
    ...new Set([
      ...(remoteManifest?.customPathRawPaths ?? []),
      ...localSnapshotContext.customPathRawPaths,
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const mergedAggregateHash = NativeAddon.buildSnapshotAggregateHash({
    variants: merge.variants,
    files: merge.files,
  });

  const currentState: CloudSaveState = decideSync({
    commits: driveRecords,
    localHash: localSnapshot.aggregateHash,
    remoteHash: activeRemoteSnapshot?.aggregateHash,
    baseId: anchor?.baseSnapshotId,
    baseHash: anchor?.baseAggregateHash,
    localEmpty: localSnapshot.files.length === 0,
  });

  return {
    driveHeadIds: heads(driveRecords).map((c) => c.id),
    context,
    customPathBindings,
    pendingCustomPathRawPaths: trackingState.pendingRawPaths,
    installationOwnedCustomPathRawPaths: [...preserveLocalMissingRawPaths],
    localSnapshot,
    localSnapshotContext,
    environmentId,
    syncDirection,
    anchor,
    activeRemoteSnapshot,
    remoteManifest,
    merge,
    mergedCustomPathRawPaths,
    mergedAggregateHash,
    state: {
      state: currentState,
      hasChanged: currentState !== "synced",
      activeRemoteSnapshot,
    },
  };
};
