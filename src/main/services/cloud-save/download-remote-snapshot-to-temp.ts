import type { SnapshotFile } from "@types";
import { downloadPC } from "../google-drive/pc-saves";
import { DriveSaveStore } from "../google-drive/store";
import { cloudSaveFileKey } from "./cloud-save-contract";

export const downloadRemoteSnapshotToTemp = async (
  snapshotId: string,
  _snapshotVersion: number,
  requestedFiles?: SnapshotFile[],
  onProgress?: (processedFiles: number, totalFiles: number) => void
) => {
  const files = await downloadPC(await new DriveSaveStore().record(snapshotId));
  const requested = requestedFiles
    ? new Map(requestedFiles.map((f) => [cloudSaveFileKey(f), f]))
    : null;
  const selected = requested
    ? files.filter((f) => requested.has(cloudSaveFileKey(f)))
    : files;
  if (
    requested &&
    (selected.length !== requested.size ||
      selected.some((f) => {
        const expected = requested.get(cloudSaveFileKey(f))!;
        return expected.hash !== f.hash || expected.sizeBytes !== f.sizeBytes;
      }))
  )
    throw new Error("drive_invalid_backup");
  onProgress?.(selected.length, selected.length);
  return selected;
};
