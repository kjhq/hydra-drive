import { app } from "electron";
import { createHash } from "node:crypto";
import path from "node:path";
import { GoogleDriveAuth } from "./auth";
import { DriveClient } from "./client";
import { DriveSaveStoreCore } from "./save-store";
export type { PublishInput } from "./save-store";
export class DriveSaveStore extends DriveSaveStoreCore {
  constructor() {
    const client = new DriveClient(),
      data = app.getPath("userData");
    super(
      client,
      path.join(
        data,
        "drive-saves",
        createHash("sha256").update(client.session.accountId).digest("hex")
      ),
      data,
      app.getPath("temp"),
      () => GoogleDriveAuth.assert(client.session)
    );
  }
}
