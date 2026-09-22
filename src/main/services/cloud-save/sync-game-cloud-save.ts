import type {
  CloudSaveConflictResolution,
  CloudSaveState,
  CloudSaveSyncProgressPayload,
  CloudSaveSyncTrigger,
  GameShop,
  SyncGameCloudSaveResult,
} from "@types";
import { isGameRunning } from "../game-running-state";
import { GoogleDriveAuth } from "../google-drive/auth";
import { DriveError } from "../google-drive/errors";
import { heads } from "../google-drive/model";
import {
  pcIdentity,
  promotePCSnapshot,
  summary,
} from "../google-drive/pc-saves";
import { confirmDriveAction } from "../google-drive/prompt";
import { DriveSaveStore } from "../google-drive/store";
import { analyzeCloudSaveState } from "./analyze-cloud-save-state";
import { assertCloudSaveExecutableExists } from "./assert-cloud-save-executable";
import { buildLocalGameSnapshotContext } from "./build-local-game-snapshot";
import { getCloudSaveGameContext } from "./cloud-save-game-context";
import { createRemoteSnapshotFromLocalState } from "./create-remote-snapshot-from-local-state";
import { assertCloudSaveEnvironmentCurrent } from "./environment-guard";
import {
  cloudSaveOperationGate,
  cloudSaveOperationScopeKey,
} from "./operation-gate";
import { restoreRemoteSnapshot } from "./restore-remote-snapshot";
import { getCloudSaveSyncAnchor, saveCloudSaveSyncAnchor } from "./sync-anchor";

const active = new Set<string>();
const offlineLaunches = new Set<string>();
type Progress = (progress: CloudSaveSyncProgressPayload) => void;
const key = (objectId: string, shop: GameShop) =>
  JSON.stringify([GoogleDriveAuth.accountId(), shop, objectId]);
export const isCloudSaveSyncActive = (objectId: string, shop: GameShop) =>
  GoogleDriveAuth.isConnected() && active.has(key(objectId, shop));

async function runSync(
  objectId: string,
  shop: GameShop,
  trigger: CloudSaveSyncTrigger,
  onProgress?: Progress,
  suppliedContext?: Awaited<ReturnType<typeof getCloudSaveGameContext>>,
  resolution?: CloudSaveConflictResolution,
  expectedHeadIds?: string[]
): Promise<SyncGameCloudSaveResult> {
  const session = GoogleDriveAuth.session();
  const operationKey = key(objectId, shop);
  const context =
    suppliedContext ?? (await getCloudSaveGameContext(objectId, shop));
  const guard = async () => {
    GoogleDriveAuth.assert(session);
    if (isGameRunning(objectId, shop))
      throw new Error("cloud_save_game_running");
    await assertCloudSaveEnvironmentCurrent(
      objectId,
      shop,
      context.environmentId
    );
  };
  await assertCloudSaveExecutableExists(objectId, shop);
  await guard();
  const progress = (
    stage: CloudSaveSyncProgressPayload["stage"],
    processedFiles = 0,
    totalFiles = 0
  ) =>
    onProgress?.({
      gameId: { objectId, shop },
      stage,
      processedFiles,
      totalFiles,
    });
  const store = new DriveSaveStore();
  const queued = async () => {
    const local = await buildLocalGameSnapshotContext(objectId, shop, context);
    await guard();
    await createRemoteSnapshotFromLocalState(objectId, shop, undefined, local, {
      baseVersion: 1,
      queueOnly: true,
      assertEnvironmentCurrent: guard,
    });
    return {
      trigger,
      action: "none",
      initialState: "local-ahead",
      finalState: "local-ahead",
      environmentId: context.environmentId,
    } as SyncGameCloudSaveResult;
  };
  if (trigger === "post-exit" && offlineLaunches.delete(operationKey))
    return queued();
  progress("analyzing");
  let analysis: Awaited<ReturnType<typeof analyzeCloudSaveState>>;
  try {
    // Frozen queued payloads are published before observing state. New branches remain conflicts.
    for (const pending of await store.queue()) {
      if (
        pending.identity.kind === "pc" &&
        pending.identity.shop === shop &&
        pending.identity.objectId === objectId &&
        pending.status !== "conflict"
      )
        await store.publishQueued(pending.id);
    }
    analysis = await analyzeCloudSaveState(objectId, shop, context);
  } catch (error) {
    if (
      error instanceof DriveError &&
      [
        "drive_offline",
        "drive_rate_limited",
        "drive_reconnect_required",
        "drive_quota_exceeded",
      ].includes(error.code)
    ) {
      if (trigger === "post-exit") return queued();
      if (trigger === "pre-launch") {
        const accepted = await confirmDriveAction({
          title: "Google Drive is unavailable",
          description:
            "Your latest cloud saves could not be checked. Play offline uses your local saves. A backup will be queued when the game exits; conflicting progress will be preserved.",
          cancelLabel: "Cancel launch",
          confirmLabel: "Play offline",
        });
        if (!accepted) throw new DriveError("drive_cancelled");
        offlineLaunches.add(operationKey);
        const anchor = await getCloudSaveSyncAnchor(
          shop,
          objectId,
          context.environmentId
        );
        return {
          trigger,
          action: "none",
          initialState: "local-ahead",
          finalState: "local-ahead",
          environmentId: context.environmentId,
          remoteHash: anchor?.baseAggregateHash,
        };
      }
    }
    throw error;
  }
  await guard();
  const records = await store.records(pcIdentity(objectId, shop));
  const currentHeads = heads(records);
  if (
    resolution &&
    (!expectedHeadIds ||
      JSON.stringify([...expectedHeadIds].sort()) !==
        JSON.stringify(currentHeads.map((c) => c.id).sort()))
  )
    throw new DriveError("drive_conflict");
  const initialState = analysis.state.state;
  const result = (
    action: SyncGameCloudSaveResult["action"],
    finalState: CloudSaveState = initialState,
    remoteHash = analysis.activeRemoteSnapshot?.aggregateHash
  ): SyncGameCloudSaveResult => ({
    trigger,
    action,
    initialState,
    finalState,
    remoteHash,
    environmentId: context.environmentId,
  });
  // A second observation changed while analysis was in flight: ask again instead of accepting unseen heads.
  const live = currentHeads.filter((c) => !c.deleted);
  if (
    !resolution &&
    (initialState === "conflict" ||
      live[0]?.id !== analysis.activeRemoteSnapshot?.id ||
      currentHeads.length > 1)
  ) {
    progress("conflict");
    return result("conflict", "conflict");
  }
  if (resolution === "keep-local" || initialState === "local-ahead") {
    progress("uploading");
    const parentIds = resolution
      ? currentHeads.map((c) => c.id)
      : analysis.anchor
        ? [analysis.anchor.baseSnapshotId]
        : [];
    const uploaded = await createRemoteSnapshotFromLocalState(
      objectId,
      shop,
      (p) => progress("uploading", p.completedFiles, p.totalFiles),
      analysis.localSnapshotContext,
      { baseVersion: 1, parentIds, assertEnvironmentCurrent: guard }
    );
    if (!uploaded) throw new DriveError("drive_request_failed");
    const after = heads(await store.records(pcIdentity(objectId, shop)));
    if (after.length !== 1 || after[0].id !== uploaded.id) {
      progress("conflict");
      return result("conflict", "conflict");
    }
    progress("completed");
    return result("upload", "synced", uploaded.aggregateHash);
  }
  if (resolution === "keep-remote" || initialState === "remote-ahead") {
    let remote = analysis.activeRemoteSnapshot;
    if (!remote) {
      progress("conflict");
      return result("conflict", "conflict");
    }
    if (resolution) {
      // Preserve differing local progress as its own snapshot before choosing a remote version.
      if (
        analysis.localSnapshot.files.length &&
        analysis.localSnapshot.aggregateHash !== remote.aggregateHash
      ) {
        const local = await createRemoteSnapshotFromLocalState(
          objectId,
          shop,
          undefined,
          analysis.localSnapshotContext,
          {
            baseVersion: 1,
            parentIds: analysis.anchor ? [analysis.anchor.baseSnapshotId] : [],
            updateAnchor: false,
            assertEnvironmentCurrent: guard,
          }
        );
        if (local) currentHeads.push(await store.record(local.id));
      }
      const observedIds = heads(
        await store.records(pcIdentity(objectId, shop))
      ).map((c) => c.id);
      // Only resolve heads actually shown to this operation plus its preserved local backup.
      if (observedIds.some((id) => !currentHeads.some((c) => c.id === id)))
        throw new DriveError("drive_conflict");
      remote = summary(await promotePCSnapshot(remote.id, observedIds));
    }
    progress("restoring");
    const restored = await restoreRemoteSnapshot(
      remote.id,
      { objectId, shop },
      (p) => progress("restoring", p.processedFiles, p.totalFiles),
      remote,
      context,
      undefined,
      true,
      [],
      0,
      guard,
      analysis.localSnapshot.aggregateHash
    );
    if (!restored.ok) throw new Error("cloud_save_restore_failed");
    progress("completed");
    return result(
      "restore",
      restored.partial ? "partial" : "synced",
      remote.aggregateHash
    );
  }
  if (
    initialState === "synced" &&
    analysis.activeRemoteSnapshot &&
    analysis.remoteManifest
  ) {
    await saveCloudSaveSyncAnchor(shop, objectId, context.environmentId, {
      schemaVersion: 4,
      environmentId: context.environmentId,
      baseSnapshotId: analysis.activeRemoteSnapshot.id,
      baseVersion: 1,
      baseAggregateHash: analysis.activeRemoteSnapshot.aggregateHash,
      entries: analysis.remoteManifest.files,
      unresolvedRemoteEntryIds: [],
      updatedAt: new Date().toISOString(),
    });
  }
  progress("completed");
  return result("none");
}
export const syncGameCloudSave = (
  objectId: string,
  shop: GameShop,
  trigger: CloudSaveSyncTrigger,
  onProgress?: Progress,
  context?: Awaited<ReturnType<typeof getCloudSaveGameContext>>,
  _expectedRemoteHash?: string | null
) =>
  GoogleDriveAuth.withSession(() =>
    cloudSaveOperationGate.runSync(
      cloudSaveOperationScopeKey(objectId, shop),
      `drive:${trigger}`,
      async () => {
        const id = key(objectId, shop);
        active.add(id);
        try {
          return await runSync(objectId, shop, trigger, onProgress, context);
        } finally {
          active.delete(id);
        }
      }
    )
  );
export const resolveCloudSaveConflict = (
  objectId: string,
  shop: GameShop,
  resolution: CloudSaveConflictResolution,
  onProgress?: Progress,
  expectedHeadIds?: string[]
) =>
  GoogleDriveAuth.withSession(() =>
    cloudSaveOperationGate.runSync(
      cloudSaveOperationScopeKey(objectId, shop),
      "drive:resolve",
      async () => {
        const id = key(objectId, shop);
        active.add(id);
        try {
          return await runSync(
            objectId,
            shop,
            "manual",
            onProgress,
            undefined,
            resolution,
            expectedHeadIds
          );
        } finally {
          active.delete(id);
        }
      }
    )
  );
