import type {
  CloudSaveGameId,
  CloudSavePathContext,
  RemoteGameSnapshot,
  RemoteSnapshotSummary,
  RestoreProgressPayload,
  RestoreRemoteSnapshotResult,
} from "@types";
import fs from "node:fs";
import { isGameRunning } from "../game-running-state";
import { GoogleDriveAuth } from "../google-drive/auth";
import { DriveError } from "../google-drive/errors";
import { heads } from "../google-drive/model";
import {
  commitManifest,
  downloadPC,
  pcIdentity,
  restoreDirectory,
  summary,
} from "../google-drive/pc-saves";
import {
  restoreTransaction,
  type RestoreChange,
} from "../google-drive/restore-runtime";
import { DriveSaveStore } from "../google-drive/store";
import { buildLocalGameSnapshotContext } from "./build-local-game-snapshot";
import { cloudSaveFileKey } from "./cloud-save-contract";
import { getCloudSaveGameContext } from "./cloud-save-game-context";
import { assertCloudSaveEnvironmentCurrent } from "./environment-guard";
import { resolveRestoreManifestTargets } from "./resolve-remote-snapshot-targets";
import { saveCloudSaveSyncAnchor } from "./sync-anchor";

export const restoreRemoteSnapshot = async (
  snapshotId: string,
  gameId: CloudSaveGameId,
  onProgress?: (progress: RestoreProgressPayload) => void,
  _knownSnapshot?: RemoteSnapshotSummary | RemoteGameSnapshot,
  suppliedContext?: {
    environmentId: string;
    pathContext: CloudSavePathContext;
  },
  requestedEntryIds?: string[],
  updateAnchor = true,
  _carriedUnresolvedEntryIds: string[] = [],
  _versionChangeAttempt = 0,
  assertEnvironmentCurrent?: () => Promise<void>,
  expectedLocalHash?: string
): Promise<RestoreRemoteSnapshotResult> => {
  const session = GoogleDriveAuth.session(),
    store = new DriveSaveStore();
  const commit = await store.record(snapshotId),
    manifest = commitManifest(commit);
  if (
    manifest.snapshot.shop !== gameId.shop ||
    manifest.snapshot.objectId !== gameId.objectId
  )
    throw new DriveError("drive_invalid_backup");
  const context =
    suppliedContext ??
    (await getCloudSaveGameContext(gameId.objectId, gameId.shop));
  const guard = async () => {
    GoogleDriveAuth.assert(session);
    if (isGameRunning(gameId.objectId, gameId.shop))
      throw new Error("cloud_save_game_running");
    await assertCloudSaveEnvironmentCurrent(
      gameId.objectId,
      gameId.shop,
      context.environmentId
    );
    await assertEnvironmentCurrent?.();
  };
  await guard();
  const assertRemote = async () => {
    const current = heads(
      await store.records(pcIdentity(gameId.objectId, gameId.shop))
    );
    if (current.length !== 1 || current[0].id !== snapshotId)
      throw new DriveError("drive_conflict");
  };
  await assertRemote();
  const emit = (
    stage: RestoreProgressPayload["stage"],
    processedFiles = 0,
    totalFiles = manifest.files.length
  ) => onProgress?.({ gameId, stage, processedFiles, totalFiles });
  const requested = requestedEntryIds ? new Set(requestedEntryIds) : null;
  const selectedFiles = requested
    ? manifest.files.filter((f) => requested.has(cloudSaveFileKey(f)))
    : manifest.files;
  const selectedVariants = new Set(selectedFiles.map((f) => f.variantId));
  const plan = await resolveRestoreManifestTargets(
    {
      ...manifest,
      files: selectedFiles,
      variants: manifest.variants.filter((v) =>
        selectedVariants.has(v.variantId)
      ),
    },
    context.pathContext
  );
  // A complete snapshot may only be applied after all applicable locations are resolved.
  if (plan.blocked.length || plan.deferred.length)
    throw new Error("cloud_save_restore_paths_unresolved");
  emit("downloading");
  try {
    const downloaded = await downloadPC(commit);
    const local = await buildLocalGameSnapshotContext(
      gameId.objectId,
      gameId.shop,
      await getCloudSaveGameContext(gameId.objectId, gameId.shop)
    );
    if (
      expectedLocalHash !== undefined &&
      local.aggregateHash !== expectedLocalHash
    )
      throw new Error("cloud_save_local_state_changed");
    const localPlan = await resolveRestoreManifestTargets(
      {
        snapshot: manifest.snapshot,
        files: local.files,
        variants: local.variants,
        customPathRawPaths: local.customPathRawPaths,
      },
      context.pathContext
    );
    const changes: RestoreChange[] = plan.actions.map((action) => ({
      target: action.targetPath,
      root: action.restoreRootPath,
      source: downloaded.find(
        (f) => cloudSaveFileKey(f) === cloudSaveFileKey(action)
      )?.tempPath,
      hash: action.hash,
      lastModifiedAt: action.lastModifiedAt,
    }));
    if (changes.some((c) => !c.source))
      throw new DriveError("drive_invalid_backup");
    if (!requested) {
      const targets = new Set(changes.map((c) => c.target));
      const remoteKeys = new Set(manifest.files.map(cloudSaveFileKey));
      for (const action of localPlan.actions) {
        if (
          !remoteKeys.has(cloudSaveFileKey(action)) &&
          !targets.has(action.targetPath)
        )
          changes.push({
            target: action.targetPath,
            root: action.restoreRootPath,
          });
      }
    }
    await guard();
    await assertRemote();
    emit("applying_restore");
    await restoreTransaction(
      JSON.stringify([gameId.shop, gameId.objectId]),
      changes,
      guard
    );
    await guard();
    if (updateAnchor) {
      const remote = summary(commit);
      await saveCloudSaveSyncAnchor(
        gameId.shop,
        gameId.objectId,
        context.environmentId,
        {
          schemaVersion: 4,
          environmentId: context.environmentId,
          baseSnapshotId: snapshotId,
          baseVersion: 1,
          baseAggregateHash: remote.aggregateHash,
          entries: manifest.files,
          unresolvedRemoteEntryIds: [],
          updatedAt: new Date().toISOString(),
        }
      );
    }
    // Concurrent publication never switches the selected snapshot; the next sync exposes the branch.
    await assertRemote();
    emit("completed", selectedFiles.length);
    return {
      ok: true,
      partial: false,
      restoredFiles: plan.actions.length,
      skippedFiles: 0,
      failedFiles: 0,
      metadataFailedPaths: 0,
      blockedFiles: 0,
      unresolvedRemoteEntryIds: [],
    };
  } finally {
    await fs.promises.rm(restoreDirectory(snapshotId), {
      recursive: true,
      force: true,
    });
  }
};
