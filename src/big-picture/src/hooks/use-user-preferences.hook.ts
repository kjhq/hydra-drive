import type { UserPreferences } from "@types";
import { useSyncExternalStore } from "react";
import { createSharedAsyncStore } from "../../../shared/shared-async-store";

const preferencesStore = createSharedAsyncStore<UserPreferences | null>({
  initial: null,
  load: async () =>
    (await globalThis.window?.electron?.getUserPreferences?.()) ?? null,
  connect: (update) =>
    globalThis.window?.electron?.onUserPreferencesUpdated?.(update) ??
    (() => {}),
});

export function useUserPreferences() {
  return useSyncExternalStore(
    preferencesStore.subscribe,
    preferencesStore.getSnapshot,
    preferencesStore.getSnapshot
  );
}
