export interface GoogleDriveConnection {
  configured: boolean;
  connected: boolean;
  account: { id: string; email: string; name: string } | null;
  persistent: boolean;
  needsReconnect: boolean;
}
export interface DriveSaveIdentity {
  kind: "pc" | "legacy" | "emulator";
  shop: string;
  objectId: string;
  slot?: string;
}
export interface DriveBackupSummary {
  id: string;
  identity: DriveSaveIdentity;
  parentIds: string[];
  createdAt: string;
  deviceName: string;
  label: string;
  sizeBytes: number;
  current: boolean;
  conflict: boolean;
  deleted: boolean;
  available: boolean;
  pinned: boolean;
}
export interface DriveQueueSummary {
  id: string;
  identity: DriveSaveIdentity;
  createdAt: string;
  status: "queued" | "conflict" | "failed";
  error?: string;
}
export interface DrivePrompt {
  id: string;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
}
