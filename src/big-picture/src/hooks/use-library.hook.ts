import { useSyncExternalStore } from "react";
import type { LibraryGame } from "@types";
import { createSharedAsyncStore } from "../../../shared/shared-async-store";

const libraryStore = createSharedAsyncStore<LibraryGame[]>({
  initial: [],
  load: async () => (await globalThis.window?.electron?.getLibrary?.()) ?? [],
  connect: (_update, invalidate) => {
    const electron = globalThis.window?.electron;
    const unsubscribeLibrary = electron?.onLibraryBatchComplete?.(invalidate);
    const unsubscribeDownloads = electron?.onDownloadsUpdated?.(invalidate);
    globalThis.window?.addEventListener("library-update", invalidate);
    return () => {
      unsubscribeLibrary?.();
      unsubscribeDownloads?.();
      globalThis.window?.removeEventListener("library-update", invalidate);
    };
  },
});

export function useLibrary() {
  const library = useSyncExternalStore(
    libraryStore.subscribe,
    libraryStore.getSnapshot,
    libraryStore.getSnapshot
  );
  return { library, updateLibrary: libraryStore.refresh };
}
