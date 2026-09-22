import type {
  GameShop,
  LocalGameSnapshotContext,
  RemoteSnapshotSummary,
  RestoreManifestResponse,
  SnapshotFile,
  SnapshotVariant,
} from "@types";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  cloudSaveFileKey,
  validateRestoreManifest,
} from "../cloud-save/cloud-save-contract";
import { NativeAddon } from "../native-addon";
import { copyVerified, extractVerified, pack } from "./archive";
import { DriveError } from "./errors";
import { heads, type DriveCommit } from "./model";
import { DriveSaveStore } from "./store";

export const pcIdentity = (objectId: string, shop: GameShop) => ({
  kind: "pc" as const,
  shop,
  objectId,
});
export function commitManifest(commit: DriveCommit): RestoreManifestResponse {
  if (commit.identity.kind !== "pc" || !commit.manifest || commit.deleted)
    throw new DriveError("drive_invalid_backup");
  const manifest = validateRestoreManifest(commit.manifest);
  if (
    manifest.snapshot.id !== commit.id ||
    manifest.snapshot.shop !== commit.identity.shop ||
    manifest.snapshot.objectId !== commit.identity.objectId
  )
    throw new DriveError("drive_invalid_backup");
  return manifest;
}
export function summary(commit: DriveCommit): RemoteSnapshotSummary {
  const manifest = commitManifest(commit);
  return {
    id: commit.id,
    version: 1,
    createdAt: commit.createdAt,
    updatedAt: commit.createdAt,
    fileCount: manifest.files.length,
    totalSizeBytes: manifest.files.reduce((sum, f) => sum + f.sizeBytes, 0),
    aggregateHash: NativeAddon.buildSnapshotAggregateHash({
      files: manifest.files,
      variants: manifest.variants,
    }),
  };
}
export async function stagePC(
  context: LocalGameSnapshotContext,
  options?: {
    files?: SnapshotFile[];
    variants?: SnapshotVariant[];
    customPathRawPaths?: string[];
  }
) {
  const directory = await fs.promises.mkdtemp(
    path.join(app.getPath("temp"), "drive-stage-")
  );
  const content = path.join(directory, "content");
  await fs.promises.mkdir(path.join(content, "files"), { recursive: true });
  const files = options?.files ?? context.files;
  const manifest: RestoreManifestResponse = {
    snapshot: {
      id: "pending",
      version: 1,
      shop: context.pathContext.shop,
      objectId: context.pathContext.objectId,
    },
    variants: options?.variants ?? context.variants,
    files,
    customPathRawPaths:
      options?.customPathRawPaths ?? context.customPathRawPaths,
  };
  try {
    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file.hash)) continue;
      const source = context.sourceFiles.find(
        (source) =>
          cloudSaveFileKey(source) === cloudSaveFileKey(file) &&
          source.hash === file.hash
      );
      if (!source) throw new DriveError("drive_invalid_backup");
      await copyVerified(
        source.absolutePath,
        path.join(content, "files", file.hash),
        file.hash,
        file.sizeBytes
      );
      seen.add(file.hash);
    }
    const archive = path.join(directory, "payload.tar.gz");
    await pack(content, archive);
    return { directory, archive, manifest };
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export const restoreDirectory = (id: string) => {
  if (!/^[\w-]{1,200}$/.test(id)) throw new DriveError("drive_invalid_backup");
  return path.join(app.getPath("temp"), "hydra-drive-restore", id);
};
export async function downloadPC(commit: DriveCommit) {
  const manifest = commitManifest(commit),
    directory = restoreDirectory(commit.id);
  await fs.promises.rm(directory, { recursive: true, force: true });
  await fs.promises.mkdir(directory, { recursive: true });
  const archive = path.join(directory, "payload.tar.gz");
  try {
    await new DriveSaveStore().download(commit, archive);
    const expected = new Map(
      manifest.files.map((f) => [
        `files/${f.hash}`,
        { hash: f.hash, size: f.sizeBytes },
      ])
    );
    await extractVerified(archive, path.join(directory, "content"), expected);
    return manifest.files.map((file) => ({
      ...file,
      tempPath: path.join(directory, "content", "files", file.hash),
    }));
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function promotePCSnapshot(
  id: string,
  expectedHeadIds: string[],
  stagedArchive?: string
) {
  const store = new DriveSaveStore();
  const commit = await store.record(id);
  const manifest = commitManifest(commit);
  const current = heads(await store.records(commit.identity))
    .map((c) => c.id)
    .sort();
  if (JSON.stringify(current) !== JSON.stringify([...expectedHeadIds].sort()))
    throw new DriveError("drive_conflict");
  const directory = await fs.promises.mkdtemp(
    path.join(app.getPath("temp"), "drive-promote-")
  );
  try {
    const archive = path.join(directory, "payload.tar.gz");
    if (stagedArchive)
      await copyVerified(
        stagedArchive,
        archive,
        commit.archiveHash!,
        commit.archiveSize
      );
    else await store.download(commit, archive);
    return await store.publish({
      identity: commit.identity,
      parentIds: current,
      label: `Restore: ${commit.label}`,
      archive,
      manifest,
      metadata: commit.metadata,
    });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}
