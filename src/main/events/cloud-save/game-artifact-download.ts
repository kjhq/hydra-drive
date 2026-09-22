import { downloadOpaque } from "@main/services/google-drive/opaque-saves";
import { DriveSaveStore } from "@main/services/google-drive/store";

export async function downloadGameArtifactPayload(
  id: string,
  target: string,
  signal?: AbortSignal
) {
  const commit = await new DriveSaveStore().record(id);
  if (commit.identity.kind !== "legacy")
    throw new Error("drive_invalid_backup");
  await downloadOpaque(commit, target, signal);
  return commit;
}
