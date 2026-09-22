import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { DriveCommit } from "../google-drive/model";
import { downloadOpaque, publishOpaque } from "../google-drive/opaque-saves";
import { DriveSaveStore } from "../google-drive/store";

import type {
  EmulationCloudSave,
  EmulationSaveEmulator,
  EmulationSaveMetadata,
  EmulationSavePlatform,
  EmulatorBinary,
} from "@types";

export const toEmulationSaveEmulator = (
  binary: EmulatorBinary
): EmulationSaveEmulator => {
  if (
    binary !== "duckstation" &&
    binary !== "pcsx2" &&
    binary !== "ppsspp" &&
    binary !== "dolphin"
  ) {
    throw new Error(`Emulator "${binary}" has no cloud emulation saves`);
  }
  return binary;
};

export interface UploadEmulationSaveInput {
  platform: EmulationSavePlatform;
  emulator: EmulationSaveEmulator;
  /** "launchbox" when the save matched a game; null (with objectId) otherwise. */
  shop: "launchbox" | null;
  objectId: string | null;
  /** Stable per-game slot id — the on-card folder name / save identifier. */
  saveIdentity: string;
  fileName: string; // must end in .psu (PS2) or .mcs (PS1)
  label: string;
  localLastModifiedAt: string; // ISO 8601
  buffer: Buffer;
  metadata?: EmulationSaveMetadata;
}

const identity = (
  input: Pick<
    UploadEmulationSaveInput,
    "platform" | "emulator" | "objectId" | "saveIdentity"
  >
) => ({
  kind: "emulator" as const,
  shop: input.platform,
  objectId: input.objectId ?? "unmatched",
  slot: `${input.emulator}:${input.saveIdentity}`,
});
const toSave = async (commit: DriveCommit): Promise<EmulationCloudSave> => {
  if (commit.identity.kind !== "emulator")
    throw new Error("drive_invalid_backup");
  const file = await new DriveSaveStore().client.metadata(commit.id);
  return {
    ...commit.metadata,
    id: commit.id,
    label: file?.appProperties?.label ?? commit.label,
    createdAt: commit.createdAt,
    updatedAt: commit.createdAt,
    lastUploadedAt: commit.createdAt,
    hostname: commit.deviceName,
    artifactLengthInBytes: commit.metadata.payloadSize,
  } as EmulationCloudSave;
};
export const uploadEmulationSave = async (
  input: UploadEmulationSaveInput
): Promise<EmulationCloudSave> => {
  const directory = await fs.promises.mkdtemp(
    path.join(app.getPath("temp"), "drive-emulator-")
  );
  try {
    const source = path.join(directory, "save");
    await fs.promises.writeFile(source, input.buffer);
    const { buffer: _, ...metadata } = input;
    return toSave(
      await publishOpaque(identity(input), source, input.label, {
        ...metadata,
        saveKind: "game_save",
      })
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};
export const listEmulationSaves = async (
  platform: EmulationSavePlatform,
  emulator: EmulationSaveEmulator,
  objectId?: string | null
): Promise<EmulationCloudSave[]> => {
  const store = new DriveSaveStore();
  const records = (await store.records()).filter(
    (c) =>
      c.identity.kind === "emulator" &&
      c.identity.shop === platform &&
      c.metadata.emulator === emulator &&
      (!objectId || c.identity.objectId === objectId)
  );
  const saves: EmulationCloudSave[] = [];
  for (const record of records) {
    if (record.deleted || !record.archiveId) continue;
    const file = await store.client.metadata(record.archiveId);
    if (file && !file.trashed) saves.push(await toSave(record));
  }
  return saves.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};
export const downloadEmulationSaveBytes = async (
  id: string
): Promise<Buffer> => {
  const record = await new DriveSaveStore().record(id);
  if (record.identity.kind !== "emulator")
    throw new Error("drive_invalid_backup");
  const directory = await fs.promises.mkdtemp(
    path.join(app.getPath("temp"), "drive-emulator-restore-")
  );
  try {
    const target = path.join(directory, "save");
    await downloadOpaque(record, target);
    return await fs.promises.readFile(target);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
};
export const deleteEmulationSave = async (id: string): Promise<void> => {
  await new DriveSaveStore().deleteBackup(id);
};
export const updateEmulationSave = async (
  id: string,
  body: { label?: string | null; metadata?: Record<string, unknown> | null }
): Promise<EmulationCloudSave> => {
  const store = new DriveSaveStore();
  await store.annotate(id, { label: body.label ?? "" });
  return toSave(await store.record(id));
};
