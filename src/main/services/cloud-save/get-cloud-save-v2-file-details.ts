import type {
  CloudSaveUnresolvedCustomPath,
  CloudSaveV2FileDetails,
  GameShop,
} from "@types";

import { analyzeCloudSaveState } from "./analyze-cloud-save-state";
import { assertCloudSaveSubscription } from "./cloud-save-access";
import { loadCloudSaveV2FileDetails } from "./cloud-save-v2-file-details";
import {
  cloudSaveCustomPathContextFromPathContext,
  decodeCloudSaveCustomPath,
  getLegacyCloudSaveCustomPathPathHint,
} from "./custom-path";
import { classifyCloudSaveCustomPathResolutionError } from "./custom-path-binding-state";
import { getRemoteSnapshotRestoreManifest } from "./resolve-remote-snapshot-targets";

const describeUnregisteredCustomPath = (
  rawPath: string,
  context: Parameters<typeof decodeCloudSaveCustomPath>[1]
): CloudSaveUnresolvedCustomPath => {
  const legacyPathHint = getLegacyCloudSaveCustomPathPathHint(rawPath);
  if (legacyPathHint) {
    return {
      rawPath,
      pathHint: legacyPathHint,
      state: "needs-confirmation",
      reason: "legacy",
      registered: false,
    };
  }

  try {
    return {
      rawPath,
      pathHint: decodeCloudSaveCustomPath(rawPath, context).path,
      state: "needs-confirmation",
      reason: "unregistered",
      registered: false,
    };
  } catch (error) {
    const classified = classifyCloudSaveCustomPathResolutionError(error);
    if (classified.state === "invalid") {
      return {
        rawPath,
        pathHint: null,
        ...classified,
        registered: false,
      };
    }
    return {
      rawPath,
      pathHint: null,
      state: "needs-confirmation",
      reason:
        classified.reason === "foreign-platform"
          ? "foreign-platform"
          : "unregistered",
      registered: false,
    };
  }
};

export const getCloudSaveV2FileDetails = async (
  objectId: string,
  shop: GameShop
): Promise<CloudSaveV2FileDetails> => {
  assertCloudSaveSubscription();

  const analysis = await analyzeCloudSaveState(objectId, shop);
  const customPathContext = cloudSaveCustomPathContextFromPathContext(
    analysis.localSnapshotContext.pathContext
  );
  const bindings = analysis.customPathBindings;
  const state = analysis.state.state;

  return loadCloudSaveV2FileDetails(
    {
      objectId,
      shop,
      state,
      localVariants: analysis.localSnapshot.variants,
      localFiles: analysis.localSnapshot.files,
      localSourceFiles: analysis.localSnapshotContext.sourceFiles,
      localTotalSizeBytes: analysis.localSnapshot.totalSizeBytes,
      activeSnapshot: analysis.state.activeRemoteSnapshot,
      coverage: analysis.localSnapshot.coverage,
      unresolvedRemoteEntryIds:
        analysis.anchor?.unresolvedRemoteEntryIds ??
        analysis.merge.unresolvedRemoteEntryIds,
      conflictEntryIds: analysis.merge.conflicts.map(
        (conflict) => conflict.entryId
      ),
      customPaths: bindings.ready,
      unresolvedCustomPaths: bindings.unresolved,
      describeUnregisteredCustomPath: (rawPath) =>
        describeUnregisteredCustomPath(rawPath, customPathContext),
    },
    getRemoteSnapshotRestoreManifest
  );
};
