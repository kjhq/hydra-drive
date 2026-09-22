import { GoogleDriveAuth } from "../google-drive/auth";

export const canAccessCloudSaves = (
  _isLoggedIn?: boolean,
  _hasActiveSubscription?: boolean
) => GoogleDriveAuth.isConnected();
export const assertCloudSaveConnection = () => {
  GoogleDriveAuth.session();
};
// Existing callers use this name; the capability now requires a Google connection only.
export const assertCloudSaveSubscription = assertCloudSaveConnection;
