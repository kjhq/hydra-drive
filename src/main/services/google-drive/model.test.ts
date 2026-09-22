import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideSync,
  heads,
  isAncestor,
  retentionCandidates,
  validateCommit,
  type DriveCommit,
} from "./model.js";
const make = (
  id: string,
  parents: string[] = [],
  createdAt = "2026-01-01T00:00:00Z"
): DriveCommit => ({
  schemaVersion: 1,
  id,
  parentIds: parents,
  createdAt,
  identity: { kind: "pc", shop: "steam", objectId: "42" },
  deviceId: "device",
  deviceName: "PC",
  label: "save",
  archiveId: `payload-${id}`,
  archiveHash: "a".repeat(64),
  archiveSize: 10,
  deleted: false,
  metadata: {},
});
test("concurrent publications preserve both heads, including equal timestamps", () => {
  const records = [
    make("base"),
    make("desktop", ["base"]),
    make("deck", ["base"]),
  ];
  assert.deepEqual(
    heads(records).map((c) => c.id),
    ["deck", "desktop"]
  );
  assert.equal(
    decideSync({
      commits: records,
      localHash: "a",
      remoteHash: "a",
      localEmpty: false,
    }),
    "conflict"
  );
});
test("resolution parents both branches without hiding a subsequently published branch", () => {
  const records = [
    make("base"),
    make("a", ["base"]),
    make("b", ["base"]),
    make("resolved", ["a", "b"]),
    make("late", ["b"]),
  ];
  assert.deepEqual(
    heads(records).map((c) => c.id),
    ["late", "resolved"]
  );
});
test("first sync never overwrites differing existing progress", () => {
  assert.equal(
    decideSync({
      commits: [make("remote")],
      localHash: "a",
      remoteHash: "b",
      localEmpty: false,
    }),
    "conflict"
  );
  assert.equal(
    decideSync({
      commits: [make("remote")],
      localHash: "a",
      remoteHash: "b",
      localEmpty: true,
    }),
    "remote-ahead"
  );
});
test("only a descendant can auto-restore over unchanged local saves", () => {
  const records = [make("base"), make("next", ["base"])];
  assert.equal(
    decideSync({
      commits: records,
      localHash: "a",
      baseHash: "a",
      baseId: "base",
      remoteHash: "b",
      localEmpty: false,
    }),
    "remote-ahead"
  );
  assert.equal(
    decideSync({
      commits: records,
      localHash: "c",
      baseHash: "a",
      baseId: "base",
      remoteHash: "b",
      localEmpty: false,
    }),
    "conflict"
  );
  assert.equal(isAncestor(records, "next", "base"), false);
});
test("deletion tombstone blocks stale local resurrection", () => {
  const records = [
    make("base"),
    {
      ...make("deleted", ["base"]),
      deleted: true,
      archiveId: null,
      archiveHash: null,
      archiveSize: 0,
    },
  ];
  assert.equal(
    decideSync({
      commits: records,
      localHash: "a",
      baseId: "base",
      baseHash: "a",
      localEmpty: false,
    }),
    "conflict"
  );
  assert.equal(heads(records)[0].id, "deleted");
});
test("retention preserves old conflict heads and pinned snapshots beyond latest ten", () => {
  const records = [make("root"), make("old-branch", ["root"])];
  let parent = "root";
  for (let i = 1; i <= 15; i++) {
    const id = `save-${i}`;
    records.push(
      make(id, [parent], `2026-02-${String(i).padStart(2, "0")}T00:00:00Z`)
    );
    parent = id;
  }
  const candidates = retentionCandidates(records, new Set(["save-1"]));
  assert(
    !candidates.some((c) => ["old-branch", "save-1", "save-15"].includes(c.id))
  );
  assert(candidates.some((c) => c.id === "save-2"));
});
test("missing ancestors and cycles fail closed", () => {
  assert.throws(() => heads([make("a", ["missing"])]), /drive_invalid_backup/);
  assert.throws(
    () => heads([make("a", ["b"]), make("b", ["a"])]),
    /drive_invalid_backup/
  );
});
test("untrusted record identities and archive integrity fields are validated", () => {
  assert.throws(
    () => validateCommit({ ...make("ok"), archiveHash: "bad" }),
    /drive_invalid_backup/
  );
  assert.throws(
    () => validateCommit({ ...make("ok"), id: "../../escape" }),
    /drive_invalid_backup/
  );
  assert.throws(
    () => validateCommit({ ...make("ok"), archiveSize: -1 }),
    /drive_invalid_backup/
  );
  assert.deepEqual(validateCommit(make("ok")), make("ok"));
});
