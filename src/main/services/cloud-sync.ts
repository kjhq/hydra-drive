import { backupsPath } from "@main/constants";
import { normalizePath } from "@main/helpers";
import { gamesSublevel, levelKeys } from "@main/level";
import { formatDate } from "@shared";
import type { GameShop } from "@types";
import i18next, { t } from "i18next";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import { isGameRunning } from "./game-running-state";
import { GoogleDriveAuth } from "./google-drive/auth";
import { legacyIdentity, publishOpaque } from "./google-drive/opaque-saves";
import { logger } from "./logger";
import { Ludusavi } from "./ludusavi";
import { SystemPath } from "./system-path";
import { WindowManager } from "./window-manager";
import { Wine } from "./wine";

export class CloudSync {
  public static getWindowsLikeUserProfilePath(winePrefixPath?: string | null) {
    if (process.platform === "linux") {
      if (!winePrefixPath) {
        throw new Error("Wine prefix path is required");
      }

      const userProfile = Wine.getWindowsUserProfilePath(winePrefixPath);
      if (!userProfile) throw new Error("User profile not found in user.reg");
      return userProfile;
    }

    return normalizePath(SystemPath.getPath("home"));
  }

  public static getBackupLabel(automatic: boolean) {
    const language = i18next.language;

    const date = formatDate(new Date(), language);

    if (automatic) {
      return t("automatic_backup_from", {
        ns: "game_details",
        date,
      });
    }

    return t("backup_from", {
      ns: "game_details",
      date,
    });
  }

  private static async bundleBackup(
    shop: GameShop,
    objectId: string,
    winePrefix: string | null
  ) {
    await fs.promises.mkdir(backupsPath, { recursive: true });
    const backupPath = await fs.promises.mkdtemp(
      path.join(backupsPath, `${shop}-${objectId}-`)
    );

    // Remove existing backup
    if (fs.existsSync(backupPath)) {
      try {
        await fs.promises.rm(backupPath, { recursive: true });
      } catch (error) {
        logger.error("Failed to remove backup path", { backupPath, error });
      }
    }

    await Ludusavi.backupGame(shop, objectId, backupPath, winePrefix);

    const tarLocation = path.join(backupsPath, `${crypto.randomUUID()}.tar`);

    await tar.create(
      {
        gzip: false,
        file: tarLocation,
        cwd: backupPath,
      },
      ["."]
    );

    await fs.promises.rm(backupPath, { recursive: true, force: true });
    return tarLocation;
  }

  public static async uploadSaveGame(
    objectId: string,
    shop: GameShop,
    downloadOptionTitle: string | null,
    label?: string
  ) {
    const session = GoogleDriveAuth.session();
    if (isGameRunning(objectId, shop))
      throw new Error("cloud_save_game_running");
    const game = await gamesSublevel.get(levelKeys.game(shop, objectId));
    const effectiveWinePrefixPath = Wine.getEffectivePrefixPath(
      game?.winePrefixPath,
      objectId
    );

    const bundleLocation = await this.bundleBackup(
      shop,
      objectId,
      effectiveWinePrefixPath
    );

    let resolvedWinePrefixPath: string | null = null;

    if (effectiveWinePrefixPath) {
      resolvedWinePrefixPath = fs.existsSync(effectiveWinePrefixPath)
        ? fs.realpathSync(effectiveWinePrefixPath)
        : effectiveWinePrefixPath;
    }

    GoogleDriveAuth.assert(session);
    const published = await publishOpaque(
      legacyIdentity(objectId, shop),
      bundleLocation,
      label ?? "Game backup",
      {
        winePrefixPath: resolvedWinePrefixPath,
        homeDir: this.getWindowsLikeUserProfilePath(effectiveWinePrefixPath),
        downloadOptionTitle,
        platform: process.platform,
      }
    );

    WindowManager.sendToAppWindows(
      `on-upload-complete-${objectId}-${shop}`,
      true
    );

    try {
      await fs.promises.unlink(bundleLocation);
    } catch (error) {
      logger.error("Failed to remove tar file", { bundleLocation, error });
    }
    return published;
  }
}
