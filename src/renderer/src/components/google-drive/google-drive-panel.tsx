import { Cloud, Check, HardDrive, History, ShieldCheck } from "lucide-react";
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
import "../../../../shared/styles/google-drive-panel.scss";
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
  intent?: "primary" | "secondary" | "danger";
}
const DefaultAction = ({
  id,
  children,
  onClick,
  disabled,
  intent = "secondary",
}: DriveActionProps) => (
  <button
    id={id}
    className={`drive-panel__button drive-panel__button--${intent}`}
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
  const {
    connection,
    loading,
    connectGoogleDrive,
    disconnectGoogleDrive,
    error,
  } = useGoogleDrive();
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<DriveQueueSummary[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setQueue(
      connection.connected && connection.account?.id
        ? await window.electron.getDriveSaveQueue()
        : []
    );
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
  const status = loading
    ? "Checking connection…"
    : connection.needsReconnect
      ? "Reconnect needed"
      : connection.connected
        ? "Connected"
        : "Not connected";
  return (
    <section
      className="drive-panel drive-panel--account"
      aria-label="Google Drive saves"
      aria-busy={busy || loading}
    >
      <div className="drive-panel__header">
        <span className="drive-panel__icon" aria-hidden="true">
          <Cloud size={24} />
        </span>
        <div className="drive-panel__heading">
          <h3>Your saves. Your Google Drive.</h3>
          <p>Keep your progress close, wherever you play.</p>
        </div>
        <span
          className={`drive-panel__status ${connection.connected ? "drive-panel__status--connected" : ""}`}
        >
          {connection.connected && <Check size={14} aria-hidden="true" />}
          {status}
        </span>
      </div>
      <div className="drive-panel__connection">
        {connection.account ? (
          <>
            <p className="drive-panel__eyebrow">GOOGLE ACCOUNT</p>
            <p className="drive-panel__account">{connection.account.email}</p>
            <p className="drive-panel__muted">
              Choose which games to sync in each game’s save settings.
            </p>
          </>
        ) : (
          <p>
            Connect once, then choose the games you want to back up. No
            subscription needed.
          </p>
        )}
        <div className="drive-panel__actions">
          <Action
            id="drive-connect"
            intent="primary"
            disabled={loading || busy || !connection.configured}
            onClick={() => void run(connectGoogleDrive)}
          >
            {busy
              ? "Working…"
              : connection.needsReconnect
                ? "Reconnect Google Drive"
                : connection.account
                  ? "Switch Google account"
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
        </div>
        {busy && (
          <p role="status" className="drive-panel__muted">
            Finish any sign-in prompt in your browser. Your saves stay on this
            device.
          </p>
        )}
        {!loading && !connection.configured && (
          <p className="drive-panel__message">
            Google sign-in isn’t available in this build yet.
          </p>
        )}
        {connection.connected && !connection.persistent && (
          <p className="drive-panel__message">
            This device can’t securely remember your account. You’ll need to
            reconnect after closing Waypoint.
          </p>
        )}
        {connection.needsReconnect && (
          <p role="alert" className="drive-panel__message">
            Your Google connection has expired. Reconnect to continue backing
            up.
          </p>
        )}
        {(error || failure) && (
          <p role="alert" className="drive-panel__message">
            {error || failure}
          </p>
        )}
      </div>
      <div className="drive-panel__facts">
        <div>
          <HardDrive size={19} aria-hidden="true" />
          <div>
            <h4>Stored in your Drive</h4>
            <p>Backups live in the Waypoint Saves folder.</p>
          </div>
        </div>
        <div>
          <History size={19} aria-hidden="true" />
          <div>
            <h4>Room to go back</h4>
            <p>Your latest 10 backups, plus any unresolved conflicts.</p>
          </div>
        </div>
        <div>
          <ShieldCheck size={19} aria-hidden="true" />
          <div>
            <h4>You stay in control</h4>
            <p>Sync is off until you turn it on for a game.</p>
          </div>
        </div>
      </div>
      {queue.length > 0 && (
        <div className="drive-panel__section">
          <div className="drive-panel__section-heading">
            <h4>
              {queue.length}{" "}
              {queue.length === 1 ? "backup waiting" : "backups waiting"}
            </h4>
            <Action
              id="drive-retry"
              disabled={busy}
              onClick={() =>
                void run(() => window.electron.retryDriveSaveQueue())
              }
            >
              Retry backups
            </Action>
          </div>
          {queue.map((item) => (
            <div className="drive-panel__queue-item" key={item.id}>
              <span>{item.identity.objectId}</span>
              <span>
                {item.status === "conflict"
                  ? "Needs your choice"
                  : item.status === "failed"
                    ? "Couldn’t upload"
                    : "Waiting to upload"}
              </span>
              {item.error && <p>{driveErrorMessage(item.error)}</p>}
            </div>
          ))}
        </div>
      )}
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
      <div className="drive-panel__heading">
        <h3>Backup history</h3>
        <p>Pick up where you left off, or return to an earlier save.</p>
      </div>
      <Action
        id="drive-history-refresh"
        onClick={() => void refresh()}
        disabled={busy}
      >
        Refresh history
      </Action>
      {error && <p role="alert">{error}</p>}
      {edit && (
        <div className="drive-panel__confirmation">
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
        <div role="alert" className="drive-panel__confirmation">
          <p>
            Delete “{deleting.label}” from Google Drive? Your saves on this
            device won’t change.
          </p>
          <Action
            id="drive-delete-confirm"
            intent="danger"
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
            Restore the backup from {selected.deviceName},{" "}
            {new Date(selected.createdAt).toLocaleString()}? Your current saves
            will be backed up first.
          </p>
          <Action
            id="drive-history-confirm"
            intent="primary"
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
            Restore backup
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
            <div className="drive-panel__snapshot-heading">
              <strong>{item.label}</strong>
              {(item.conflict || item.current) && (
                <span className="drive-panel__status">
                  {item.conflict ? "Needs your choice" : "Latest backup"}
                </span>
              )}
            </div>
            <p className="drive-panel__muted">
              {item.deviceName} · {new Date(item.createdAt).toLocaleString()}
            </p>
            <div className="drive-panel__actions">
              {identity.kind === "pc" && (
                <Action
                  id={`drive-restore-${item.id}`}
                  disabled={disabled || busy}
                  onClick={() => setSelected(item)}
                >
                  Restore
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
                Export
              </Action>
            </div>
          </div>
        ))}
      {!items.some((item) => item.available && !item.deleted) && !error && (
        <div className="drive-panel__empty">
          <History size={28} aria-hidden="true" />
          <h4>No backups yet</h4>
          <p>Create your first backup from this game’s save settings.</p>
        </div>
      )}
    </section>
  );
}
