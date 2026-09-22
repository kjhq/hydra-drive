export type DriveErrorCode =
  | "drive_not_configured"
  | "drive_not_connected"
  | "drive_reconnect_required"
  | "drive_account_changed"
  | "drive_cancelled"
  | "drive_offline"
  | "drive_quota_exceeded"
  | "drive_rate_limited"
  | "drive_invalid_backup"
  | "drive_backup_missing"
  | "drive_conflict"
  | "drive_request_failed";

export class DriveError extends Error {
  constructor(public readonly code: DriveErrorCode) {
    super(code);
    this.name = "DriveError";
  }
}
export function classifyDriveError(
  status: number,
  reason?: string
): DriveError {
  if (status === 401) return new DriveError("drive_reconnect_required");
  if (reason === "storageQuotaExceeded")
    return new DriveError("drive_quota_exceeded");
  if (
    status === 429 ||
    reason === "rateLimitExceeded" ||
    reason === "userRateLimitExceeded"
  )
    return new DriveError("drive_rate_limited");
  if (status === 404 || status === 410)
    return new DriveError("drive_backup_missing");
  return new DriveError("drive_request_failed");
}
