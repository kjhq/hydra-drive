import {
  GoogleDriveHistory,
  GoogleDrivePanel,
  type DriveActionProps,
  type DriveTextProps,
} from "@renderer/components/google-drive/google-drive-panel";
import type { DriveSaveIdentity } from "@types";
import { Button, Input, VerticalFocusGroup } from "../common";
const DriveAction = ({
  id,
  children,
  onClick,
  disabled,
  intent = "secondary",
}: DriveActionProps) => (
  <Button focusId={id} onClick={onClick} disabled={disabled} variant={intent}>
    {children}
  </Button>
);
const DriveText = ({ value, onChange, disabled }: DriveTextProps) => (
  <Input
    focusId="drive-backup-label"
    label="Backup label"
    value={value}
    onChange={(event) => onChange(event.target.value)}
    disabled={disabled}
  />
);
export function BigPictureDriveSettings(_props: { className?: string }) {
  return (
    <VerticalFocusGroup regionId="google-drive-settings">
      <GoogleDrivePanel Action={DriveAction} />
    </VerticalFocusGroup>
  );
}
export function BigPictureDriveHistory({
  identity,
  disabled,
  onRestored,
}: {
  identity: DriveSaveIdentity;
  disabled?: boolean;
  onRestored?: () => void;
}) {
  return (
    <VerticalFocusGroup regionId="google-drive-history">
      <GoogleDriveHistory
        identity={identity}
        disabled={disabled}
        onRestored={onRestored}
        Action={DriveAction}
        Text={DriveText}
      />
    </VerticalFocusGroup>
  );
}
