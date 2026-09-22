import {
  driveErrorMessage,
  useGoogleDrive,
} from "@renderer/hooks/use-google-drive";
import type {
  DriveBackupSummary,
  DriveQueueSummary,
  DriveSaveIdentity,
} from "@types";
import {
  useCallback,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import "./google-drive-panel.scss";
export interface DriveTextProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}
const DefaultText = ({ value, onChange, disabled }: DriveTextProps) => (
  <input
    aria-label="Backup label"
    value={value}
    onChange={(event) => onChange(event.target.value)}
    disabled={disabled}
  />
);
export interface DriveActionProps {
  id: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}
const DefaultAction = ({
  id,
  children,
  onClick,
  disabled,
}: DriveActionProps) => (
  <button
    id={id}
    className="drive-panel__button"
    type="button"
    onClick={onClick}
    disabled={disabled}
  >
    {children}
  </button>
);
export function GoogleDrivePanel({
  Action = DefaultAction,
}: {
  Action?: ComponentType<DriveActionProps>;
}) {
  const { connection, connectGoogleDrive, disconnectGoogleDrive, error } =
    useGoogleDrive();
  const [busy, setBusy] = useState(false),
    [queue, setQueue] = useState<DriveQueueSummary[]>([]),
    [failure, setFailure] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (connection.connected && connection.account?.id)
      setQueue(await window.electron.getDriveSaveQueue());
    else setQueue([]);
  }, [connection.connected, connection.account?.id]);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      setFailure(driveErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="drive-panel" aria-label="Google Drive saves">
      <h3>Google Drive saves</h3>
      <p>
        {connection.account?.email ??
          "Back up your progress to your own Google Drive."}
      </p>
      <p>
        Backups appear in <strong>Hydra Drive Saves</strong>. Enable automatic
        sync in each game’s save settings. The latest 10 snapshots and
        unresolved conflicts are retained.
      </p>
      {!connection.persistent && (
        <p>
          Your system keyring is unavailable. The connection will last for this
          session only.
        </p>
      )}
      {connection.needsReconnect && (
        <p role="alert">
          Google authorization has expired or been revoked. Reconnect to resume
          queued backups.
        </p>
      )}
      {!connection.configured && (
        <p>This build needs the maintainer’s Google OAuth configuration.</p>
      )}
      <div className="drive-panel__actions">
        <Action
          id="drive-connect"
          disabled={busy || !connection.configured}
          onClick={() => void run(() => connectGoogleDrive())}
        >
          {connection.account
            ? "Reconnect / switch account"
            : "Connect Google Drive"}
        </Action>
        {connection.account && (
          <Action
            id="drive-disconnect"
            disabled={busy}
            onClick={() => void run(disconnectGoogleDrive)}
          >
            Disconnect
          </Action>
        )}
        {connection.connected && (
          <Action
            id="drive-retry"
            disabled={busy}
            onClick={() =>
              void run(() => window.electron.retryDriveSaveQueue())
            }
          >
            Retry queued backups ({queue.length})
          </Action>
        )}
        {connection.connected && (
          <Action
            id="drive-import-local"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await window.electron.importLocalHydraSettings();
                setFailure(
                  `Imported ${result.games} games and ${result.paths} save paths. Automatic sync remains off.`
                );
              })
            }
          >
            Import local Hydra library and save paths
          </Action>
        )}
      </div>
      {(error || failure) && <p role="alert">{error || failure}</p>}
      {queue.map((item) => (
        <p key={item.id}>
          {item.identity.objectId}: {item.status}
          {item.error ? ` — ${driveErrorMessage(item.error)}` : ""}
        </p>
      ))}
      <p className="drive-panel__note">
        Close official Hydra before importing its local library and path
        selections. Existing Hydra Cloud backups are not imported. Restore any
        cloud-only saves using official Hydra before switching.
      </p>
    </section>
  );
}
export function GoogleDriveHistory({
  identity,
  Action = DefaultAction,
  Text = DefaultText,
  disabled = false,
  onRestored,
}: {
  identity: DriveSaveIdentity;
  Action?: ComponentType<DriveActionProps>;
  Text?: ComponentType<DriveTextProps>;
  disabled?: boolean;
  onRestored?: () => void;
}) {
  const [items, setItems] = useState<DriveBackupSummary[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<DriveBackupSummary | null>(null),
    [label, setLabel] = useState(""),
    [deleting, setDeleting] = useState<DriveBackupSummary | null>(null);
  const [selected, setSelected] = useState<DriveBackupSummary | null>(null);
  const { connection } = useGoogleDrive();
  const identityJson = JSON.stringify(identity);
  const refresh = useCallback(async () => {
    if (!connection.connected || !connection.account?.id) {
      setItems([]);
      return;
    }
    setError(null);
    try {
      setItems(
        await window.electron.getDriveBackupHistory(JSON.parse(identityJson))
      );
    } catch (error) {
      setError(driveErrorMessage(error));
    }
  }, [identityJson, connection.connected, connection.account?.id]);
  useEffect(() => {
    setItems([]);
    setSelected(null);
    void refresh();
  }, [refresh]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setSelected(null);
      setEdit(null);
      setDeleting(null);
      await refresh();
      onRestored?.();
    } catch (error) {
      setError(driveErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  if (!connection.connected) return null;
  return (
    <section className="drive-panel" aria-label="Google Drive backup history">
      <h3>Google Drive backup history</h3>
      <Action
        id="drive-history-refresh"
        onClick={() => void refresh()}
        disabled={busy}
      >
        Refresh history
      </Action>
      {error && <p role="alert">{error}</p>}
      {edit && (
        <div>
          <Text value={label} onChange={setLabel} disabled={busy} />
          <Action
            id="drive-label-save"
            disabled={busy || !label.trim()}
            onClick={() =>
              void run(() =>
                window.electron.updateDriveBackup(edit.id, {
                  label: label.trim(),
                })
              )
            }
          >
            Save label
          </Action>
          <Action
            id="drive-label-cancel"
            disabled={busy}
            onClick={() => setEdit(null)}
          >
            Cancel
          </Action>
        </div>
      )}
      {deleting && (
        <div role="alert">
          <p>
            Delete {deleting.label} from Google Drive? Local saves will remain
            on this device.
          </p>
          <Action
            id="drive-delete-confirm"
            disabled={busy}
            onClick={() =>
              void run(() => window.electron.deleteDriveBackup(deleting.id))
            }
          >
            Delete cloud backup
          </Action>
          <Action
            id="drive-delete-cancel"
            disabled={busy}
            onClick={() => setDeleting(null)}
          >
            Cancel
          </Action>
        </div>
      )}
      {selected ? (
        <div role="alert" className="drive-panel__confirmation">
          <p>
            Replace local progress with the snapshot from {selected.deviceName},{" "}
            {new Date(selected.createdAt).toLocaleString()}? Your current saves
            will be backed up first.
          </p>
          <Action
            id="drive-history-confirm"
            disabled={busy || disabled}
            onClick={() =>
              void run(() =>
                window.electron.restoreDriveBackup(
                  selected.id,
                  items.filter((item) => item.current).map((item) => item.id)
                )
              )
            }
          >
            Restore this snapshot
          </Action>
          <Action
            id="drive-history-cancel"
            disabled={busy}
            onClick={() => setSelected(null)}
          >
            Cancel
          </Action>
        </div>
      ) : null}
      {items
        .filter((item) => item.available && !item.deleted)
        .map((item) => (
          <div key={item.id} className="drive-panel__snapshot">
            <p>
              <strong>{item.label}</strong> — {item.deviceName} ·{" "}
              {new Date(item.createdAt).toLocaleString()}
              {item.conflict
                ? " · Conflicting progress"
                : item.current
                  ? " · Current"
                  : ""}
            </p>
            <div className="drive-panel__actions">
              {identity.kind === "pc" && (
                <Action
                  id={`drive-restore-${item.id}`}
                  disabled={disabled || busy}
                  onClick={() => setSelected(item)}
                >
                  Choose snapshot
                </Action>
              )}
              <Action
                id={`drive-rename-${item.id}`}
                disabled={busy}
                onClick={() => {
                  setEdit(item);
                  setLabel(item.label);
                  setSelected(null);
                  setDeleting(null);
                }}
              >
                Rename
              </Action>
              <Action
                id={`drive-delete-${item.id}`}
                disabled={disabled || busy}
                onClick={() => {
                  setDeleting(item);
                  setSelected(null);
                  setEdit(null);
                }}
              >
                Delete
              </Action>
              <Action
                id={`drive-export-${item.id}`}
                disabled={busy}
                onClick={() =>
                  void run(() => window.electron.exportDriveBackup(item.id))
                }
              >
                Export archive
              </Action>
            </div>
          </div>
        ))}
      {!items.length && !error && <p>No Google Drive backups yet.</p>}
    </section>
  );
}
