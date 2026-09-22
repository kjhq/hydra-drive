import type { EventEmitter } from "node:events";

/** A read-through library snapshot invalidated by every relevant root DB write,
 * including root batches that target the games sublevel. */
export function createLibraryGamesSnapshot<T>(
  database: Pick<EventEmitter, "on" | "removeListener">,
  games: {
    values: () => { all: () => Promise<T[]> };
    prefixKey: (key: string, format: "utf8") => string;
  }
) {
  const prefix = games.prefixKey("", "utf8");
  let revision = 0;
  let snapshot: T[] | undefined;
  let pending: Promise<T[]> | undefined;
  const invalidate = () => {
    revision++;
    snapshot = undefined;
  };
  const onWrite = (operations: Array<{ key: unknown }>) => {
    if (
      operations.some((operation) => String(operation.key).startsWith(prefix))
    )
      invalidate();
  };
  database.on("write", onWrite);
  // A sublevel clear is forwarded through the root. Invalidating for every
  // clear also covers ranged clears and sign-out without decoding range bounds.
  database.on("clear", invalidate);
  database.on("closed", invalidate);

  return {
    read(): Promise<T[]> {
      if (snapshot) return Promise.resolve(snapshot);
      if (pending) return pending;
      pending = (async () => {
        for (;;) {
          const startedRevision = revision;
          const gamesSnapshot = await games.values().all();
          if (startedRevision !== revision) continue;
          snapshot = gamesSnapshot;
          return gamesSnapshot;
        }
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    dispose() {
      database.removeListener("write", onWrite);
      database.removeListener("clear", invalidate);
      database.removeListener("closed", invalidate);
      invalidate();
    },
  };
}
