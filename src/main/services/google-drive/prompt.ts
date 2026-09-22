import type { DrivePrompt } from "@types";
import { randomUUID } from "node:crypto";
import { WindowManager } from "../window-manager";
import { GoogleDriveAuth } from "./auth";
let pending: {
  prompt: DrivePrompt;
  senderId: number;
  finish: (accepted: boolean) => void;
} | null = null;
export function currentDrivePrompt(senderId: number) {
  return pending?.senderId === senderId ? pending.prompt : null;
}
export function answerDrivePrompt(
  senderId: number,
  id: string,
  accepted: boolean
) {
  if (pending?.senderId === senderId && pending.prompt.id === id)
    pending.finish(accepted === true);
}
export async function confirmDriveAction(
  input: Omit<DrivePrompt, "id">
): Promise<boolean> {
  const session = GoogleDriveAuth.session(),
    window = WindowManager.getDrivePromptWindow();
  if (pending || !window) throw new Error("cloud_save_operation_active");
  const prompt = { ...input, id: randomUUID() };
  return new Promise<boolean>((resolve) => {
    const finish = (accepted: boolean) => {
      if (pending?.prompt.id !== prompt.id) return;
      pending = null;
      clearTimeout(timeout);
      session.signal.removeEventListener("abort", cancel);
      window.removeListener("closed", cancel);
      if (!window.isDestroyed())
        window.webContents.send("drive-prompt-changed", null);
      resolve(accepted);
    };
    const cancel = () => finish(false),
      timeout = setTimeout(cancel, 5 * 60_000);
    pending = { prompt, senderId: window.webContents.id, finish };
    session.signal.addEventListener("abort", cancel, { once: true });
    window.once("closed", cancel);
    window.webContents.send("drive-prompt-changed", prompt);
    window.show();
    window.focus();
  });
}
