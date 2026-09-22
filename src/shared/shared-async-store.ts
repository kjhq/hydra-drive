/** One request and one upstream subscription for all mounted consumers. */
export function createSharedAsyncStore<T>(options: {
  initial: T;
  load: () => Promise<T>;
  connect: (update: (value: T) => void, invalidate: () => void) => () => void;
}) {
  let value = options.initial;
  let revision = 0;
  let generation = 0;
  let pending: Promise<void> | undefined;
  let needsRefresh = false;
  let disconnect: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const publish = (next: T) => {
    if (Object.is(value, next)) return;
    value = next;
    listeners.forEach((listener) => listener());
  };

  const ensureLoaded = (): Promise<void> => {
    if (pending) return pending;
    const startedGeneration = generation;
    const request = Promise.resolve().then(async () => {
      do {
        needsRefresh = false;
        const startedRevision = revision;
        const next = await options.load();
        if (startedGeneration !== generation) return;
        if (startedRevision === revision) publish(next);
        // Events during a request must not be lost, or an old library snapshot
        // can hide a just-completed import/download until the next event.
      } while (needsRefresh);
    });
    pending = request;
    const clear = () => {
      if (pending === request) pending = undefined;
    };
    void request.then(clear, clear);
    return request;
  };

  const refresh = (): Promise<void> => {
    revision++;
    needsRefresh = true;
    return ensureLoaded();
  };

  const invalidate = () => {
    void refresh().catch(() => undefined);
  };

  return {
    getSnapshot: () => value,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        const connectedGeneration = generation;
        disconnect = options.connect(
          (next) => {
            if (generation !== connectedGeneration) return;
            revision++;
            publish(next);
          },
          () => {
            if (generation === connectedGeneration) invalidate();
          }
        );
        void ensureLoaded().catch(() => undefined);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          generation++;
          disconnect?.();
          disconnect = undefined;
          pending = undefined;
        }
      };
    },
  };
}
