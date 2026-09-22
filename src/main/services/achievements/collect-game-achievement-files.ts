import type { AchievementFile, Game } from "@types";

import { Wine } from "../wine";
import {
  findAchievementFileInSteamPath,
  findAchievementFiles,
  findAllAchievementFiles,
  getAlternativeObjectIds,
} from "./find-achievement-files";
import { findGameDirectoryAchievementFiles } from "./find-game-directory-achievement-files";
import { resolveGameExecutablePath } from "./resolve-game-executable-path";
import {
  findNestedAchievementFiles,
  type NestedAchievementFiles,
} from "./find-nested-achievement-files";

interface CollectGameAchievementFilesOptions {
  includeSteamCache?: boolean;
  staticFilesByObjectId?: Map<string, AchievementFile[]>;
  nestedFilesByObjectId?: NestedAchievementFiles;
  awaitGameDirectoryLocations?: boolean;
}

const getEffectiveWinePrefixPath = (game: Game) =>
  Wine.getEffectivePrefixPath(game.winePrefixPath, game.objectId) ?? "";

const dedupeAchievementFiles = (achievementFiles: AchievementFile[]) => {
  const filesByKey = new Map<string, AchievementFile>();

  for (const file of achievementFiles) {
    filesByKey.set(`${file.type}:${file.filePath}`, file);
  }

  return [...filesByKey.values()];
};

export const collectGameAchievementFiles = async (
  game: Game,
  {
    includeSteamCache = false,
    staticFilesByObjectId,
    nestedFilesByObjectId,
    awaitGameDirectoryLocations = false,
  }: CollectGameAchievementFilesOptions = {}
): Promise<AchievementFile[]> => {
  if (game.shop !== "steam") return [];

  const achievementFiles: AchievementFile[] = staticFilesByObjectId
    ? getAlternativeObjectIds(game.objectId).flatMap(
        (objectId) => staticFilesByObjectId.get(objectId) ?? []
      )
    : await findAchievementFiles(game);

  const [nestedFiles, gameDirectoryFiles] = await Promise.all([
    nestedFilesByObjectId ??
      findNestedAchievementFiles(getEffectiveWinePrefixPath(game)),
    findGameDirectoryAchievementFiles(resolveGameExecutablePath(game), {
      awaitLocations: awaitGameDirectoryLocations,
    }),
  ]);

  for (const objectId of getAlternativeObjectIds(game.objectId)) {
    achievementFiles.push(...(nestedFiles.get(objectId) ?? []));
  }

  achievementFiles.push(...gameDirectoryFiles);

  if (includeSteamCache) {
    achievementFiles.push(...findAchievementFileInSteamPath(game));
  }

  return dedupeAchievementFiles(achievementFiles);
};

/** Share discovery maps across games in one watcher pass (especially shared Wine prefixes). */
export const createAchievementFileCollector = () => {
  const prefixes = new Map<
    string,
    Promise<[Map<string, AchievementFile[]>, NestedAchievementFiles]>
  >();
  return async (
    game: Game,
    options: CollectGameAchievementFilesOptions = {}
  ) => {
    if (game.shop !== "steam") return [];
    const prefix =
      process.platform === "win32" ? "" : getEffectiveWinePrefixPath(game);
    let discovery = prefixes.get(prefix);
    if (!discovery) {
      discovery = Promise.all([
        findAllAchievementFiles(prefix),
        findNestedAchievementFiles(prefix),
      ]);
      prefixes.set(prefix, discovery);
    }
    const [staticFilesByObjectId, nestedFilesByObjectId] = await discovery;
    return collectGameAchievementFiles(game, {
      ...options,
      staticFilesByObjectId,
      nestedFilesByObjectId,
    });
  };
};
