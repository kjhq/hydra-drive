import fs from "node:fs";
import path from "node:path";

interface Entry<T> {
  value?: T;
  ready: boolean;
  revision: number;
  scannedRevision: number;
  scannedAt: number;
  lastUsedAt: number;
  pending?: Promise<T>;
  subscription?: WatchSubscription<T>;
  rearm: boolean;
}
interface WatchSubscription<T> {
  watcher: fs.FSWatcher;
  entries: Set<Entry<T>>;
  key: string;
  createdAt: number;
}

/** Watches discovery roots, not individual files. Polling remains the fallback
 * when a filesystem cannot be watched; periodic scans recover missed events. */
export function createWatchedDirectoryCache<T>({
  reconcileMs = 60_000,
  idleMs = 300_000,
  now = Date.now,
  watch = fs.watch,
} = {}) {
  const entries = new Map<string, Entry<T>>();
  const subscriptions = new Map<string, WatchSubscription<T>>();
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  const close = (entry: Entry<T>) => {
    const subscription = entry.subscription;
    if (!subscription) return;
    entry.subscription = undefined;
    subscription.entries.delete(entry);
    if (!subscription.entries.size) {
      subscription.watcher.close();
      subscriptions.delete(subscription.key);
    }
  };
  const invalidateWatch = (members: Set<Entry<T>>) => {
    for (const member of [...members]) {
      close(member);
      member.revision++;
      member.rearm = true;
    }
  };
  const prune = () => {
    for (const [root, entry] of entries) {
      if (!entry.pending && now() - entry.lastUsedAt >= idleMs) {
        close(entry);
        entries.delete(root);
      }
    }
    if (!entries.size) {
      clearInterval(cleanupTimer);
      cleanupTimer = undefined;
    }
  };

  const arm = (root: string, entry: Entry<T>) => {
    close(entry);
    entry.rearm = false;
    let candidate = root;
    for (;;) {
      const recursive = candidate === root;
      const key = `${recursive ? "recursive" : "shallow"}:${candidate}`;
      const existing = subscriptions.get(key);
      if (existing) {
        existing.entries.add(entry);
        entry.subscription = existing;
        return;
      }
      try {
        // Missing roots share a shallow watch on the nearest existing ancestor.
        // Never recursively watch an entire home directory for a missing save.
        const members = new Set([entry]);
        const watcher = watch(
          candidate,
          { recursive, persistent: false },
          (event) => {
            if (event === "rename") {
              invalidateWatch(members);
              return;
            }
            for (const member of members) {
              member.revision++;
            }
          }
        );
        const subscription = {
          watcher,
          entries: members,
          key,
          createdAt: now(),
        };
        subscriptions.set(key, subscription);
        entry.subscription = subscription;
        watcher.on("error", () => invalidateWatch(members));
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return;
        const parent = path.dirname(candidate);
        if (parent === candidate) return;
        candidate = parent;
      }
    }
  };

  return {
    async get(root: string, scan: () => Promise<T>): Promise<T> {
      root = path.resolve(root);
      let entry = entries.get(root);
      if (!entry) {
        entry = {
          ready: false,
          revision: 0,
          scannedRevision: -1,
          scannedAt: 0,
          lastUsedAt: now(),
          rearm: true,
        };
        entries.set(root, entry);
      }
      entry.lastUsedAt = now();
      // Expire inactive roots instead of evicting a still-active library in a
      // cycle when its number of Wine prefixes exceeds a fixed cache size.
      cleanupTimer ??= setInterval(prune, idleMs).unref();
      if (entry.pending) return entry.pending;
      const reconciliationDue = now() - entry.scannedAt >= reconcileMs;
      if (
        entry.subscription &&
        now() - entry.subscription.createdAt >= reconcileMs
      ) {
        invalidateWatch(entry.subscription.entries);
      }
      if (entry.rearm || !entry.subscription || reconciliationDue)
        arm(root, entry);
      if (
        entry.subscription &&
        entry.ready &&
        entry.scannedRevision === entry.revision &&
        !reconciliationDue
      )
        return entry.value!;

      const revision = entry.revision;
      const current = entry;
      const pending = Promise.resolve()
        .then(scan)
        .then((value) => {
          current.value = value;
          current.ready = true;
          current.scannedRevision = revision;
          current.scannedAt = now();
          return value;
        })
        .finally(() => {
          current.pending = undefined;
        });
      current.pending = pending;
      return pending;
    },
    clear() {
      clearInterval(cleanupTimer);
      cleanupTimer = undefined;
      entries.forEach(close);
      entries.clear();
    },
  };
}
