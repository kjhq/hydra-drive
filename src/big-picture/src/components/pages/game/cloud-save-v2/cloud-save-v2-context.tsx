import {
  driveErrorMessage,
  useGoogleDrive,
} from "@renderer/hooks/use-google-drive";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { BigPictureDriveHistory } from "../../../google-drive";

import {
  getCloudSaveSyncErrorKind,
  getCustomPathApprovalError,
  getCustomPathApprovalErrorKey,
  type CustomPathApprovalError,
  shouldSyncCloudSaveOnGamePage,
} from "@renderer/pages/game-details/cloud-save-v2/cloud-save-presentation";
import { useCloudSaveOverview } from "@renderer/pages/game-details/cloud-save-v2/use-cloud-save-overview";
import type {
  CloudSaveConflictResolution,
  CloudSaveCustomPathApproval,
  CloudSaveOverview,
  CloudSaveSyncProgressPayload,
  GameShop,
} from "@types";

import { useBigPictureToast } from "../../../../hooks";
import { BigPictureCloudSaveConflictModal } from "./cloud-save-conflict-modal";
import { BigPictureCloudSaveCustomPathModal } from "./cloud-save-custom-path-modal";
import {
  BigPictureCloudSaveModal,
  type BigPictureCloudSavePanelProps,
} from "./cloud-save-modal";

import "./styles.scss";

interface BigPictureCloudSaveContextValue {
  overview: CloudSaveOverview | null;
  isRefreshing: boolean;
  isSyncing: boolean;
  hasError: boolean;
  progress: CloudSaveSyncProgressPayload | null;
  canUseCloudSaves: boolean;
  hasExecutablePath: boolean;
  openManager: () => void;
  panelProps: Omit<
    BigPictureCloudSavePanelProps,
    "showLaunchConflictWarning" | "onSelectExecutable"
  >;
}

const bigPictureCloudSaveContext =
  createContext<BigPictureCloudSaveContextValue | null>(null);

export function useBigPictureCloudSave() {
  const context = useContext(bigPictureCloudSaveContext);

  if (!context) {
    throw new Error(
      "useBigPictureCloudSave must be used within BigPictureCloudSaveProvider"
    );
  }

  return context;
}

interface BigPictureCloudSaveProviderProps {
  children: ReactNode;
  objectId: string;
  shop: GameShop;
  hasExecutablePath: boolean;
  isGameRunning: boolean;
  enableGamePageSync?: boolean;
  onSelectExecutable: () => void;
}

export function BigPictureCloudSaveProvider({
  children,
  objectId,
  shop,
  hasExecutablePath,
  isGameRunning,
  enableGamePageSync = true,
  onSelectExecutable,
}: Readonly<BigPictureCloudSaveProviderProps>) {
  const { t } = useTranslation("game_details");
  const [searchParams, setSearchParams] = useSearchParams();
  const { driveAccount, isDriveConnected } = useGoogleDrive();
  const { showErrorToast, showSuccessToast, showWarningToast } =
    useBigPictureToast();
  const canUseCloudSaves = Boolean(driveAccount) && isDriveConnected;
  const canCheckCloudSaves =
    shop === "steam" && canUseCloudSaves && hasExecutablePath;
  const { overview, isRefreshing, hasRefreshError, refresh } =
    useCloudSaveOverview({
      objectId,
      shop,
      enabled: canCheckCloudSaves,
    });

  const [isModalVisible, setIsModalVisible] = useState(false);
  const [wasOpenedFromLaunchConflict, setWasOpenedFromLaunchConflict] =
    useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [hasSyncError, setHasSyncError] = useState(false);
  const [progress, setProgress] = useState<CloudSaveSyncProgressPayload | null>(
    null
  );
  const [customPathApproval, setCustomPathApproval] =
    useState<CloudSaveCustomPathApproval | null>(null);
  const [customPathApprovalError, setCustomPathApprovalError] =
    useState<CustomPathApprovalError | null>(null);
  const [isSelectingCustomPath, setIsSelectingCustomPath] = useState(false);
  const [isConfirmingCustomPath, setIsConfirmingCustomPath] = useState(false);
  const [isFileExplorerVisible, setIsFileExplorerVisible] = useState(false);
  const [pendingResolution, setPendingResolution] =
    useState<CloudSaveConflictResolution | null>(null);
  const gameKey = `${shop}:${objectId}`;
  const activeGameKey = useRef(gameKey);
  const gamePageSyncInFlight = useRef(false);

  activeGameKey.current = gameKey;

  const showSyncError = useCallback(
    (error: unknown) => {
      if (error instanceof Error && error.message.includes("drive_")) {
        showErrorToast(driveErrorMessage(error));
        return true;
      }
      const errorKind = getCloudSaveSyncErrorKind(error);

      if (errorKind === "restore-metadata") {
        showErrorToast(t("cloud_save_v2_restore_metadata_failed_title"), {
          message: t("cloud_save_v2_restore_metadata_failed_description"),
        });
        return true;
      }

      if (errorKind !== "generic") {
        showErrorToast(
          t(
            errorKind === "snapshot-too-large"
              ? "cloud_save_v2_snapshot_too_large_title"
              : "cloud_save_v2_too_many_files_title"
          ),
          {
            message: t(
              errorKind === "snapshot-too-large"
                ? "cloud_save_v2_snapshot_too_large_description"
                : "cloud_save_v2_too_many_files_description"
            ),
          }
        );
        return true;
      }

      showErrorToast(t("cloud_save_v2_auto_sync_failed_title"), {
        message: t("cloud_save_v2_auto_sync_failed_description"),
      });
      return false;
    },
    [showErrorToast, t]
  );

  useEffect(() => {
    setIsModalVisible(false);
    setWasOpenedFromLaunchConflict(false);
    setIsSyncing(false);
    setHasSyncError(false);
    setProgress(null);
    setCustomPathApproval(null);
    setCustomPathApprovalError(null);
    setIsSelectingCustomPath(false);
    setIsConfirmingCustomPath(false);
    setIsFileExplorerVisible(false);
    setPendingResolution(null);
    gamePageSyncInFlight.current = false;
  }, [gameKey]);

  useEffect(() => {
    if (shop !== "steam" || searchParams.get("openCloudSaveConflict") !== "1") {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("openCloudSaveConflict");
    setSearchParams(nextSearchParams, { replace: true });
    setWasOpenedFromLaunchConflict(true);
    setIsModalVisible(true);
  }, [searchParams, setSearchParams, shop]);

  useEffect(() => {
    if (
      shop !== "steam" ||
      searchParams.get("openCloudSavePathApproval") !== "1"
    ) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("openCloudSavePathApproval");
    setSearchParams(nextSearchParams, { replace: true });

    let canceled = false;
    setCustomPathApprovalError(null);
    void globalThis.window.electron
      .getPendingCloudSaveCustomPathApproval(objectId, shop)
      .then((approval) => {
        if (!canceled) setCustomPathApproval(approval);
      })
      .catch(() => {
        if (canceled) return;
        setCustomPathApprovalError("generic");
        showErrorToast(t("cloud_save_v2_path_approval_error_title"), {
          message: t("cloud_save_v2_path_approval_load_error_description"),
        });
      });

    return () => {
      canceled = true;
    };
  }, [objectId, searchParams, setSearchParams, shop, showErrorToast, t]);

  useEffect(() => {
    return globalThis.window.electron.onCloudSaveAutomaticSync((event) => {
      if (event.gameId.objectId !== objectId || event.gameId.shop !== shop) {
        return;
      }

      if (event.status === "progress") {
        setIsSyncing(true);
        setHasSyncError(false);
        setProgress(event.progress);
        return;
      }

      if (event.status === "failed") {
        const isKnownError = showSyncError(event.errorCode);
        setHasSyncError(!isKnownError);
      } else {
        setHasSyncError(false);
        if (event.status === "conflict" && event.trigger !== "pre-launch") {
          showWarningToast(t("cloud_save_v2_auto_sync_conflict_title"), {
            message: t("cloud_save_v2_auto_sync_conflict_description"),
          });
        }
      }

      const requestedGame = `${event.gameId.shop}:${event.gameId.objectId}`;
      void refresh().finally(() => {
        if (activeGameKey.current === requestedGame) {
          setIsSyncing(false);
        }
      });
    });
  }, [objectId, refresh, shop, showSyncError, showWarningToast, t]);

  useEffect(() => {
    if (
      !enableGamePageSync ||
      customPathApproval !== null ||
      searchParams.get("openCloudSavePathApproval") === "1" ||
      !shouldSyncCloudSaveOnGamePage({
        overview,
        shop,
        canUseCloudSaves,
        hasExecutablePath,
        isGameRunning,
        isSyncing,
        isInFlight: gamePageSyncInFlight.current,
      })
    ) {
      return;
    }

    const requestedGame = gameKey;
    gamePageSyncInFlight.current = true;

    void globalThis.window.electron
      .syncCloudSaveOnGamePage(objectId, shop)
      .catch((error) => {
        if (activeGameKey.current !== requestedGame) return;
        const isKnownError = showSyncError(error);
        setHasSyncError(!isKnownError);
      })
      .finally(() => {
        if (activeGameKey.current === requestedGame) {
          gamePageSyncInFlight.current = false;
        }
      });
  }, [
    canUseCloudSaves,
    customPathApproval,
    enableGamePageSync,
    gameKey,
    hasExecutablePath,
    isGameRunning,
    isSyncing,
    objectId,
    overview,
    searchParams,
    shop,
    showSyncError,
  ]);

  const runCloudSaveOperation = useCallback(
    async (resolution?: CloudSaveConflictResolution) => {
      if (
        isGameRunning ||
        isSyncing ||
        !hasExecutablePath ||
        !canUseCloudSaves ||
        shop !== "steam"
      ) {
        return false;
      }

      const requestedGame = gameKey;
      setIsSyncing(true);
      setHasSyncError(false);
      setProgress(null);

      try {
        const onProgress = (nextProgress: CloudSaveSyncProgressPayload) => {
          if (activeGameKey.current === requestedGame) {
            setProgress(nextProgress);
          }
        };

        if (resolution) {
          await globalThis.window.electron.resolveCloudSaveConflict(
            objectId,
            shop,
            resolution,
            onProgress,
            overview?.driveHeadIds
          );
        } else {
          const result =
            await globalThis.window.electron.syncGameCloudSaveFromModal(
              objectId,
              shop,
              null,
              onProgress
            );

          if (
            activeGameKey.current === requestedGame &&
            result.status === "approval-required"
          ) {
            setCustomPathApproval(result.approval);
          }
        }
        return true;
      } catch (error) {
        if (activeGameKey.current === requestedGame) {
          const isKnownError = showSyncError(error);
          setHasSyncError(!isKnownError);
        }
        return false;
      } finally {
        if (activeGameKey.current === requestedGame) {
          await refresh();
          setIsSyncing(false);
        }
      }
    },
    [
      overview?.driveHeadIds,
      canUseCloudSaves,
      gameKey,
      hasExecutablePath,
      isGameRunning,
      isSyncing,
      objectId,
      refresh,
      shop,
      showSyncError,
    ]
  );

  const handleAutomaticSyncChange = async (enabled: boolean) => {
    if (!canUseCloudSaves) {
      throw new Error("Connect Google Drive to use cloud saves");
    }

    try {
      await globalThis.window.electron.setCloudSaveAutomaticSyncEnabled(
        objectId,
        shop,
        enabled
      );
      await refresh();
    } catch (error) {
      showErrorToast(t("cloud_save_v2_toggle_error_title"), {
        message: t("cloud_save_v2_toggle_error_description"),
      });
      throw error;
    }
  };

  const handleSelectCustomPath = async (selectedPath: string) => {
    const approvalId = customPathApproval?.id;
    if (!approvalId || isSelectingCustomPath || isConfirmingCustomPath) return;

    setIsFileExplorerVisible(false);
    setIsSelectingCustomPath(true);
    setCustomPathApprovalError(null);

    try {
      const result =
        await globalThis.window.electron.selectCloudSaveCustomPathApproval(
          approvalId,
          selectedPath
        );
      if (!result.canceled) setCustomPathApproval(result.approval);
    } catch (error) {
      setCustomPathApprovalError(getCustomPathApprovalError(error));
    } finally {
      setIsSelectingCustomPath(false);
    }
  };

  const handleConfirmCustomPathApproval = async () => {
    const approval = customPathApproval;
    if (!approval || isSelectingCustomPath || isConfirmingCustomPath) return;

    const requestedGame = gameKey;
    setIsConfirmingCustomPath(true);
    setCustomPathApprovalError(null);

    try {
      if (approval.purpose === "manual-sync") {
        setIsSyncing(true);
        const result =
          await globalThis.window.electron.syncGameCloudSaveFromModal(
            objectId,
            shop,
            approval.id,
            (nextProgress) => {
              if (activeGameKey.current === requestedGame) {
                setProgress(nextProgress);
              }
            }
          );

        if (activeGameKey.current === requestedGame) {
          setCustomPathApproval(
            result.status === "approval-required" ? result.approval : null
          );
        }
      } else if (approval.purpose === "custom-path-rebind") {
        const confirmed =
          await globalThis.window.electron.confirmCloudSaveCustomPathRebindApproval(
            approval.id,
            objectId,
            shop
          );
        setIsSyncing(true);
        await globalThis.window.electron.syncCloudSaveAfterCustomPathRebind(
          objectId,
          shop,
          confirmed.rawPath,
          (nextProgress) => {
            if (activeGameKey.current === requestedGame) {
              setProgress(nextProgress);
            }
          }
        );
        setCustomPathApproval(null);
        showSuccessToast(t("cloud_save_v2_custom_path_rebound"));
      } else {
        const result =
          await globalThis.window.electron.confirmCloudSaveCustomPathApproval(
            approval.id
          );
        setCustomPathApproval(result.pendingApproval);
      }
    } catch (error) {
      setCustomPathApprovalError(getCustomPathApprovalError(error));
      if (approval.purpose !== "pre-launch") {
        setHasSyncError(true);
      }
    } finally {
      if (activeGameKey.current === requestedGame) {
        await refresh();
        setIsSyncing(false);
        setIsConfirmingCustomPath(false);
      }
    }
  };

  const handleCloseCustomPathApproval = () => {
    if (isSelectingCustomPath || isConfirmingCustomPath) return;

    const approvalId = customPathApproval?.id;
    setCustomPathApproval(null);
    setCustomPathApprovalError(null);
    setIsFileExplorerVisible(false);

    if (approvalId) {
      void globalThis.window.electron
        .dismissCloudSaveCustomPathApproval(approvalId)
        .catch(() => undefined);
    }
  };

  const handleConfirmResolution = () => {
    const resolution = pendingResolution;
    if (!resolution) return;

    void runCloudSaveOperation(resolution).then((completed) => {
      if (completed) setPendingResolution(null);
    });
  };

  const customPathErrorKey = getCustomPathApprovalErrorKey(
    customPathApprovalError,
    customPathApproval?.purpose
  );
  const customPathErrorMessage = customPathErrorKey
    ? t(customPathErrorKey)
    : undefined;
  const hasError = hasRefreshError || hasSyncError;
  let errorMessageKey:
    | "cloud_save_v2_sync_error"
    | "cloud_save_v2_load_error"
    | null = null;
  if (hasSyncError) {
    errorMessageKey = "cloud_save_v2_sync_error";
  } else if (hasRefreshError) {
    errorMessageKey = "cloud_save_v2_load_error";
  }
  const panelProps = {
    overview,
    isLoading: isRefreshing,
    isSyncing,
    isGameRunning,
    hasExecutablePath,
    hasError,
    errorMessageKey,
    progress,
    onSync: () => void runCloudSaveOperation(),
    onAutomaticSyncChange: handleAutomaticSyncChange,
    onResolveConflict: setPendingResolution,
  } satisfies Omit<
    BigPictureCloudSavePanelProps,
    "showLaunchConflictWarning" | "onSelectExecutable"
  >;
  const value: BigPictureCloudSaveContextValue = {
    overview,
    isRefreshing,
    isSyncing,
    hasError,
    progress,
    canUseCloudSaves,
    hasExecutablePath,
    panelProps,
    openManager: () => {
      if (!canUseCloudSaves) {
        void window.electron
          .connectGoogleDrive()
          .catch(() => showErrorToast("Unable to connect Google Drive"));
        return;
      }
      setWasOpenedFromLaunchConflict(false);
      setIsModalVisible(true);
    },
  };

  return (
    <bigPictureCloudSaveContext.Provider value={value}>
      {children}

      <BigPictureCloudSaveModal
        history={
          isModalVisible && (
            <BigPictureDriveHistory
              identity={{ kind: "pc", shop, objectId }}
              disabled={isGameRunning || isSyncing}
              onRestored={() => void refresh()}
            />
          )
        }
        {...panelProps}
        visible={isModalVisible}
        showLaunchConflictWarning={wasOpenedFromLaunchConflict}
        onSelectExecutable={() => {
          setIsModalVisible(false);
          onSelectExecutable();
        }}
        onClose={() => {
          setIsModalVisible(false);
          setWasOpenedFromLaunchConflict(false);
        }}
      />

      <BigPictureCloudSaveCustomPathModal
        approval={customPathApproval}
        isSelecting={isSelectingCustomPath}
        isConfirming={isConfirmingCustomPath}
        isFileExplorerVisible={isFileExplorerVisible}
        errorMessage={customPathErrorMessage}
        onOpenFileExplorer={() => setIsFileExplorerVisible(true)}
        onCloseFileExplorer={() => setIsFileExplorerVisible(false)}
        onSelectPath={(path) => void handleSelectCustomPath(path)}
        onConfirm={() => void handleConfirmCustomPathApproval()}
        onClose={handleCloseCustomPathApproval}
      />

      <BigPictureCloudSaveConflictModal
        resolution={pendingResolution}
        isResolving={isSyncing}
        onClose={() => setPendingResolution(null)}
        onConfirm={handleConfirmResolution}
      />
    </bigPictureCloudSaveContext.Provider>
  );
}
