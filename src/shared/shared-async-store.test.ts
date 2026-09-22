import assert from "node:assert/strict";
import { test } from "node:test";
import { createSharedAsyncStore } from "./shared-async-store.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("thousands of consumers share one request and upstream subscription", async () => {
  let reads = 0,
    connections = 0,
    disconnections = 0;
  const store = createSharedAsyncStore({
    initial: 0,
    load: async () => ++reads,
    connect: () => {
      connections++;
      return () => {
        disconnections++;
      };
    },
  });
  const unsubscribers = Array.from({ length: 6000 }, () =>
    store.subscribe(() => {})
  );
  await store.refresh();
  assert.equal(reads, 1);
  assert.equal(connections, 1);
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  assert.equal(disconnections, 1);
});

test("a pushed preference change wins over an older in-flight read", async () => {
  const read = deferred<string>();
  let update!: (value: string) => void;
  const store = createSharedAsyncStore({
    initial: "",
    load: () => read.promise,
    connect: (push) => {
      update = push;
      return () => {};
    },
  });
  const unsubscribe = store.subscribe(() => {});
  const refreshing = store.refresh();
  await Promise.resolve();
  update("new");
  read.resolve("old");
  await refreshing;
  assert.equal(store.getSnapshot(), "new");
  unsubscribe();
});

test("an invalidation during a library read fetches fresh data exactly once", async () => {
  const first = deferred<string>();
  let invalidate!: () => void,
    reads = 0;
  const store = createSharedAsyncStore({
    initial: "",
    load: async () => (++reads === 1 ? first.promise : "new"),
    connect: (_push, changed) => {
      invalidate = changed;
      return () => {};
    },
  });
  const unsubscribe = store.subscribe(() => {});
  const refreshing = store.refresh();
  await Promise.resolve();
  invalidate();
  invalidate();
  first.resolve("old");
  await refreshing;
  assert.equal(reads, 2);
  assert.equal(store.getSnapshot(), "new");
  unsubscribe();
});

test("an explicit refresh after a mutation supersedes an in-flight read", async () => {
  const first = deferred<string>();
  let database = "before mutation";
  let reads = 0;
  const snapshots: string[] = [];
  const store = createSharedAsyncStore({
    initial: "",
    load: async () => (++reads === 1 ? first.promise : database),
    connect: () => () => {},
  });
  const unsubscribe = store.subscribe(() =>
    snapshots.push(store.getSnapshot())
  );
  await Promise.resolve();

  // Some library mutations have no broadcast; their caller explicitly refreshes.
  database = "after mutation";
  const refreshing = store.refresh();
  const coalescedRefresh = store.refresh();
  first.resolve("before mutation");
  await Promise.all([refreshing, coalescedRefresh]);

  assert.equal(reads, 2);
  assert.equal(store.getSnapshot(), database);
  assert.deepEqual(snapshots, [database]);
  unsubscribe();
});

test("unmount/remount ignores the previous connection's response and callbacks", async () => {
  const first = deferred<string>();
  const pushes: Array<(value: string) => void> = [];
  let reads = 0;
  const store = createSharedAsyncStore({
    initial: "",
    load: async () => (++reads === 1 ? first.promise : "fresh"),
    connect: (push) => {
      pushes.push(push);
      return () => {};
    },
  });
  const unsubscribe = store.subscribe(() => {});
  const oldRequest = store.refresh();
  await Promise.resolve();
  unsubscribe();
  const nextUnsubscribe = store.subscribe(() => {});
  await store.refresh();
  pushes[0]("stale-event");
  first.resolve("stale-response");
  await oldRequest;
  assert.equal(store.getSnapshot(), "fresh");
  nextUnsubscribe();
});

test("a failed request releases the single-flight slot for retry", async () => {
  let reads = 0;
  const store = createSharedAsyncStore({
    initial: "",
    load: async () => {
      if (++reads === 1) throw new Error("offline");
      return "recovered";
    },
    connect: () => () => {},
  });
  const unsubscribe = store.subscribe(() => {});
  await assert.rejects(store.refresh(), /offline/);
  await store.refresh();
  assert.equal(store.getSnapshot(), "recovered");
  unsubscribe();
});
