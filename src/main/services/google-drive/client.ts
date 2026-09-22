import { GoogleDriveAuth, type DriveSession } from "./auth";
import { DriveHttpClient } from "./http-client";
export type { DriveFile } from "./http-client";
export class DriveClient extends DriveHttpClient {
  constructor(session: DriveSession = GoogleDriveAuth.session()) {
    super(session, {
      assert: (session) => GoogleDriveAuth.assert(session),
      accessToken: (session, force) =>
        GoogleDriveAuth.accessToken(session, force),
    });
  }
}
