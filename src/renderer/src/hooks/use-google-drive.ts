import type { GoogleDriveConnection } from "@types";
import { useCallback, useEffect, useState } from "react";

const initial: GoogleDriveConnection = {
  configured: false,
  connected: false,
  account: null,
  persistent: false,
  needsReconnect: false,
};
export function useGoogleDrive() {
  const [connection, setConnection] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true,
      changed = false;
    const unsubscribe = window.electron.onGoogleDriveConnectionChanged(
      (value) => {
        changed = true;
        setConnection(value);
      }
    );
    void window.electron
      .getGoogleDriveConnection()
      .then((value) => {
        if (mounted && !changed) setConnection(value);
      })
      .catch(() => {
        if (mounted) setError("Unable to read Google Drive connection");
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  const connect = useCallback(async (..._args: unknown[]) => {
    setError(null);
    try {
      setConnection(await window.electron.connectGoogleDrive());
    } catch (error) {
      setError(driveErrorMessage(error));
    }
  }, []);
  const disconnect = useCallback(async () => {
    setConnection(await window.electron.disconnectGoogleDrive());
  }, []);
  return {
    connection,
    isDriveConnected: connection.connected,
    driveAccount: connection.connected ? connection.account : null,
    connectGoogleDrive: connect,
    disconnectGoogleDrive: disconnect,
    error,
  };
}
export function driveErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    drive_not_configured:
      "Google Drive is not configured in this build. Contact the fork maintainer.",
    drive_not_connected: "Connect your Google account to use cloud saves.",
    drive_reconnect_required: "Reconnect Google Drive to continue syncing.",
    drive_account_changed:
      "The Google account changed. The previous operation was cancelled.",
    drive_cancelled: "Connection or operation cancelled.",
    drive_offline:
      "Google Drive is unavailable. Your local saves are unchanged.",
    drive_quota_exceeded:
      "Your Google Drive is full. Free some space and retry.",
    drive_rate_limited:
      "Google Drive is temporarily limiting requests. Try again shortly.",
    drive_conflict:
      "Another device changed these saves. Refresh and choose a snapshot again.",
    drive_invalid_backup: "This backup failed validation. It was not restored.",
    drive_backup_missing: "This backup was deleted or is no longer available.",
  };
  return (
    Object.entries(messages).find(([code]) => message.includes(code))?.[1] ??
    "The save operation failed. Your previous backups are preserved."
  );
}
