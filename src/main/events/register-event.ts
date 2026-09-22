import { ipcMain } from "electron";
import { GoogleDriveAuth } from "../services/google-drive/auth";

export const registerEvent = (
  name: string,
  listener: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any
) => {
  ipcMain.handle(name, async (event: Electron.IpcMainInvokeEvent, ...args) => {
    return Promise.resolve(
      GoogleDriveAuth.withOptionalSession(() => listener(event, ...args))
    ).then((result) => {
      if (!result) return result;
      return JSON.parse(JSON.stringify(result));
    });
  });
};
