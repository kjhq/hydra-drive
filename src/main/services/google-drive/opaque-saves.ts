import type { DriveSaveIdentity, GameArtifact, GameShop } from "@types";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { copyVerified, extractVerified, hashFile, pack } from "./archive";
import { DriveError } from "./errors";
import { heads, type DriveCommit } from "./model";
import { confirmDriveAction } from "./prompt";
import { DriveSaveStore } from "./store";

export const legacyIdentity = (
  objectId: string,
  shop: GameShop
): DriveSaveIdentity => ({ kind: "legacy", shop, objectId });
export async function publishOpaque(
  identity: DriveSaveIdentity,
  source: string,
  label: string,
  metadata: Record<string, unknown>
) {
  const store = new DriveSaveStore();
  const base = await store.acceptedBase(identity);
  const parentIds = base ? [base] : [];
  const directory = await fs.promises.mkdtemp(
    path.join(app.getPath("temp"), "drive-opaque-")
  );
  try {
    const content = path.join(directory, "content");
    await fs.promises.mkdir(content);
    const payload = path.join(content, "payload.bin");
    await copyVerified(source, payload);
    const payloadHash = await hashFile(payload),
      payloadSize = (await fs.promises.stat(payload)).size;
    const archive = path.join(directory, "payload.tar.gz");
    await pack(content, archive);
    return await store.publish({
      identity,
      parentIds,
      label,
      archive,
      metadata: { ...metadata, payloadHash, payloadSize },
    });
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}
export async function downloadOpaque(
  commit: DriveCommit,
  target: string,
  signal?: AbortSignal
) {
  const hash = commit.metadata.payloadHash,
    size = commit.metadata.payloadSize;
  if (
    typeof hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0
  )
    throw new DriveError("drive_invalid_backup");
  const directory = await fs.promises.mkdtemp(
    path.join(app.getPath("temp"), "drive-download-")
  );
  try {
    const archive = path.join(directory, "payload.tar.gz");
    await new DriveSaveStore().download(commit, archive, signal);
    const content = path.join(directory, "content");
    await extractVerified(
      archive,
      content,
      new Map([["payload.bin", { hash, size }]])
    );
    await fs.promises.copyFile(
      path.join(content, "payload.bin"),
      target,
      fs.constants.COPYFILE_EXCL
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}
export async function legacyArtifacts(
  objectId: string,
  shop: GameShop
): Promise<GameArtifact[]> {
  const store = new DriveSaveStore();
  const identity = legacyIdentity(objectId, shop);
  const records = await store.records(identity);
  const history = await store.history(identity);
  return history
    .filter((c) => c.available && !c.deleted)
    .map((c) => ({
      id: c.id,
      artifactLengthInBytes: c.sizeBytes,
      downloadOptionTitle: String(
        records.find((r) => r.id === c.id)?.metadata.downloadOptionTitle ?? ""
      ),
      createdAt: c.createdAt,
      updatedAt: c.createdAt,
      hostname: c.deviceName,
      downloadCount: 0,
      label: c.label,
      isFrozen: c.pinned,
    }));
}

export async function confirmOpaqueRestore(id: string) {
  const store = new DriveSaveStore(),
    commit = await store.record(id);
  const current = heads(await store.records(commit.identity));
  const accepted = await confirmDriveAction({
    title: "Restore this backup?",
    description: `Restore “${commit.label}” from ${commit.deviceName}, ${new Date(commit.createdAt).toLocaleString()}?\n\nProgress currently in Drive:\n${current.map((c) => `${c.deviceName} · ${new Date(c.createdAt).toLocaleString()}${c.deleted ? " · Deleted" : ""}`).join("\n")}\n\nYour current saves will be backed up first. Other versions stay in your history.`,
    cancelLabel: "Cancel",
    confirmLabel: "Restore backup",
  });
  if (!accepted) throw new DriveError("drive_cancelled");
  return { commit, expected: current.map((c) => c.id) };
}
export async function finishOpaqueRestore(
  id: string,
  expected: string[],
  verifiedPayload: string | Buffer
) {
  const store = new DriveSaveStore(),
    commit = await store.record(id);
  const current = heads(await store.records(commit.identity))
    .map((c) => c.id)
    .sort();
  if (JSON.stringify(current) !== JSON.stringify([...expected].sort()))
    throw new DriveError("drive_conflict");
  if (current.length === 1 && current[0] === id) {
    await store.acceptBase(commit.identity, id);
    return;
  }
  const directory = await fs.promises.mkdtemp(
    path.join(app.getPath("temp"), "drive-opaque-resolve-")
  );
  try {
    const content = path.join(directory, "content");
    await fs.promises.mkdir(content);
    const payload = path.join(content, "payload.bin");
    if (typeof verifiedPayload === "string")
      await copyVerified(verifiedPayload, payload);
    else await fs.promises.writeFile(payload, verifiedPayload);
    if ((await hashFile(payload)) !== commit.metadata.payloadHash)
      throw new DriveError("drive_invalid_backup");
    const archive = path.join(directory, "payload.tar.gz");
    await pack(content, archive);
    const resolved = await store.publish({
      identity: commit.identity,
      parentIds: current,
      label: `Restore: ${commit.label}`,
      archive,
      metadata: commit.metadata,
    });
    await store.acceptBase(commit.identity, resolved.id);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}
