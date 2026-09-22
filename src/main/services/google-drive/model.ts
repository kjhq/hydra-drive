import type { DriveSaveIdentity, RestoreManifestResponse } from "@types";
import { createHash } from "node:crypto";
import { DriveError } from "./errors.js";

export interface DriveCommit {
  schemaVersion: 1;
  id: string;
  parentIds: string[];
  identity: DriveSaveIdentity;
  createdAt: string;
  deviceId: string;
  deviceName: string;
  label: string;
  archiveId: string | null;
  archiveHash: string | null;
  archiveSize: number;
  deleted: boolean;
  manifest?: RestoreManifestResponse;
  metadata: Record<string, unknown>;
}
export const identityKey = (identity: DriveSaveIdentity) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        identity.kind,
        identity.shop,
        identity.objectId,
        identity.slot ?? null,
      ])
    )
    .digest("hex");
export const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[\w-]{1,200}$/.test(id);
export const validHash = (hash: unknown): hash is string =>
  typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash);
export function validateCommit(value: unknown): DriveCommit {
  const c = value as DriveCommit;
  if (
    !c ||
    c.schemaVersion !== 1 ||
    !validId(c.id) ||
    !Array.isArray(c.parentIds) ||
    !c.parentIds.every(validId) ||
    c.parentIds.includes(c.id) ||
    !c.identity ||
    !["pc", "legacy", "emulator"].includes(c.identity.kind) ||
    typeof c.identity.shop !== "string" ||
    typeof c.identity.objectId !== "string" ||
    (c.identity.slot !== undefined && typeof c.identity.slot !== "string") ||
    !Number.isFinite(Date.parse(c.createdAt)) ||
    typeof c.deviceId !== "string" ||
    typeof c.deviceName !== "string" ||
    typeof c.label !== "string" ||
    typeof c.deleted !== "boolean" ||
    !Number.isSafeInteger(c.archiveSize) ||
    c.archiveSize < 0 ||
    !c.metadata ||
    typeof c.metadata !== "object" ||
    (!c.deleted && (!validId(c.archiveId) || !validHash(c.archiveHash))) ||
    (c.deleted && (c.archiveId !== null || c.archiveHash !== null))
  )
    throw new DriveError("drive_invalid_backup");
  return c;
}
export function heads(commits: DriveCommit[]) {
  const byId = new Map(commits.map((c) => [c.id, c]));
  if (byId.size !== commits.length)
    throw new DriveError("drive_invalid_backup");
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new DriveError("drive_invalid_backup");
    if (visited.has(id)) return;
    visiting.add(id);
    const c = byId.get(id);
    if (!c) throw new DriveError("drive_invalid_backup");
    for (const parent of c.parentIds) {
      if (byId.has(parent)) visit(parent);
      else throw new DriveError("drive_invalid_backup");
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const c of commits) visit(c.id);
  const parents = new Set(commits.flatMap((c) => c.parentIds));
  return commits
    .filter((c) => !parents.has(c.id))
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
    );
}
export function isAncestor(
  commits: DriveCommit[],
  ancestor: string,
  descendant: string
): boolean {
  const byId = new Map(commits.map((c) => [c.id, c]));
  const pending = [descendant],
    seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === ancestor) return true;
    if (!seen.has(id)) {
      seen.add(id);
      pending.push(...(byId.get(id)?.parentIds ?? []));
    }
  }
  return false;
}
export function retentionCandidates(
  commits: DriveCommit[],
  pinned: Set<string>,
  count = 10
) {
  const protectedIds = new Set([...heads(commits).map((c) => c.id), ...pinned]);
  const payloads = commits
    .filter((c) => !c.deleted)
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
    );
  payloads.slice(0, count).forEach((c) => protectedIds.add(c.id));
  return payloads.filter((c) => !protectedIds.has(c.id));
}
export function decideSync(input: {
  commits: DriveCommit[];
  localHash: string;
  remoteHash?: string;
  baseId?: string;
  baseHash?: string;
  localEmpty: boolean;
}) {
  const current = heads(input.commits);
  if (current.length > 1) return "conflict" as const;
  const remote = current[0];
  if (!remote)
    return input.localEmpty ? ("synced" as const) : ("local-ahead" as const);
  if (remote.deleted)
    return input.localEmpty ? ("synced" as const) : ("conflict" as const);
  if (input.localHash === input.remoteHash) return "synced" as const;
  if (!input.baseId)
    return input.localEmpty ? ("remote-ahead" as const) : ("conflict" as const);
  if (input.baseId === remote.id) return "local-ahead" as const;
  if (
    input.localHash === input.baseHash &&
    isAncestor(input.commits, input.baseId, remote.id)
  )
    return "remote-ahead" as const;
  return "conflict" as const;
}
