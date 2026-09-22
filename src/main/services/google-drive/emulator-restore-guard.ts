import { emulatorSessions } from "../emulators/emulator-session-tracker";
import { NativeAddon } from "../native-addon";
import { recoverRestores } from "./restore-runtime";
let busy = false;
export async function assertEmulatorsStopped() {
  if (emulatorSessions.size) throw new Error("cloud_save_game_running");
  const processes = await NativeAddon.getSystemProcessMap();
  if (!processes) throw new Error("cloud_save_process_check_failed");
  if (
    Object.keys(processes.processMap).some((name) =>
      /duckstation|pcsx2|ppsspp|dolphin|retroarch/i.test(name)
    )
  )
    throw new Error("cloud_save_game_running");
}
export async function withEmulatorSaveLock<T>(
  operation: () => Promise<T>
): Promise<T> {
  if (busy) throw new Error("cloud_save_operation_active");
  busy = true;
  try {
    await recoverRestores("emulator", assertEmulatorsStopped);
    return await operation();
  } finally {
    busy = false;
  }
}
