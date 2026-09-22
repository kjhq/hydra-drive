import type {
  CloudSaveUploadProgress,
  GameShop,
  LocalGameSnapshotContext,
  RemoteGameSnapshot,
  SnapshotFile,
  SnapshotVariant,
} from "@types";
import fs from "node:fs";
import { GoogleDriveAuth } from "../google-drive/auth";
import { pcIdentity, stagePC, summary } from "../google-drive/pc-saves";
import { DriveSaveStore } from "../google-drive/store";
import { buildLocalGameSnapshotContext } from "./build-local-game-snapshot";
import { getCloudSaveSyncAnchor, saveCloudSaveSyncAnchor } from "./sync-anchor";

export interface CreateRemoteSnapshotOptions {
  baseVersion: number;
  expectedSnapshotId?: string | null;
  unresolvedRemoteEntryIds?: string[];
  updateAnchor?: boolean;
  assertEnvironmentCurrent?: () => Promise<void>;
  customPathRawPaths?: string[];
  variants?: SnapshotVariant[];
  files?: SnapshotFile[];
  aggregateHash?: string;
  parentIds?: string[];
  queueOnly?: boolean;
}
export const createRemoteSnapshotFromLocalState = async (
  objectId: string,
  shop: GameShop,
  onProgress?: (progress: CloudSaveUploadProgress) => void,
  localSnapshotContext?: LocalGameSnapshotContext,
  options?: CreateRemoteSnapshotOptions
): Promise<RemoteGameSnapshot | null> => {
  const session = GoogleDriveAuth.session();
  const context =
    localSnapshotContext ??
    (await buildLocalGameSnapshotContext(objectId, shop));
  const anchor = await getCloudSaveSyncAnchor(
    shop,
    objectId,
    context.environmentId
  );
  const parentIds =
    options?.parentIds ??
    (options?.expectedSnapshotId
      ? [options.expectedSnapshotId]
      : anchor
        ? [anchor.baseSnapshotId]
        : []);
  const staged = await stagePC(context, options);
  try {
    await options?.assertEnvironmentCurrent?.();
    GoogleDriveAuth.assert(session);
    onProgress?.({
      completedFiles: 0,
      totalFiles: staged.manifest.files.length,
      completedBytes: 0,
      totalBytes: context.totalSizeBytes,
      currentFile: null,
    });
    const store = new DriveSaveStore();
    const input = {
      identity: pcIdentity(objectId, shop),
      parentIds,
      label: "Game save",
      archive: staged.archive,
      manifest: staged.manifest,
    };
    if (options?.queueOnly) {
      await store.enqueue(input);
      return null;
    }
    const commit = await store.publish(input);
    GoogleDriveAuth.assert(session);
    const snapshot = summary(commit);
    if (options?.updateAnchor !== false)
      await saveCloudSaveSyncAnchor(shop, objectId, context.environmentId, {
        schemaVersion: 4,
        environmentId: context.environmentId,
        baseSnapshotId: snapshot.id,
        baseVersion: 1,
        baseAggregateHash: snapshot.aggregateHash,
        entries: staged.manifest.files,
        unresolvedRemoteEntryIds: options?.unresolvedRemoteEntryIds ?? [],
        updatedAt: new Date().toISOString(),
      });
    onProgress?.({
      completedFiles: snapshot.fileCount,
      totalFiles: snapshot.fileCount,
      completedBytes: snapshot.totalSizeBytes,
      totalBytes: snapshot.totalSizeBytes,
      currentFile: null,
    });
    return snapshot;
  } finally {
    await fs.promises.rm(staged.directory, { recursive: true, force: true });
  }
};
