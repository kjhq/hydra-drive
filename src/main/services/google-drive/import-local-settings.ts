import {
  cloudSaveCustomPathsSublevel,
  emulatorsSublevel,
  gamesSublevel,
  levelKeys,
} from "@main/level";
import type { EmulatorConfig, EmulatorSystem, Game } from "@types";
import { ClassicLevel } from "classic-level";
import { app, dialog } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeStoredCloudSaveCustomPathEntries } from "../cloud-save/custom-path-binding-state";
import { WindowManager } from "../window-manager";
import { GoogleDriveAuth } from "./auth";

// Open a temporary copy: never modify the original Hydra database or copy its credentials.
export async function importLocalHydraSettings() {
  const session = GoogleDriveAuth.session();
  const selection = await dialog.showOpenDialog({
    title: "Close official Hydra, then select its user-data folder",
    properties: ["openDirectory"],
  });
  if (selection.canceled) return { games: 0, paths: 0 };
  const source = await fs.realpath(selection.filePaths[0]);
  if (source === (await fs.realpath(app.getPath("userData"))))
    throw new Error("Select the original Hydra folder");
  const sourceDb = path.join(source, "hydra-db");
  if (!(await fs.stat(path.join(sourceDb, "CURRENT"))).isFile())
    throw new Error("This folder has no Hydra database");
  const directory = await fs.mkdtemp(
    path.join(app.getPath("temp"), "drive-local-import-")
  );
  const copy = path.join(directory, "db");
  let old: ClassicLevel<string, unknown> | undefined;
  try {
    await fs.cp(sourceDb, copy, {
      recursive: true,
      filter: async (file) => {
        if ((await fs.lstat(file)).isSymbolicLink())
          throw new Error("Symlinks are not supported in the source database");
        return path.basename(file) !== "LOCK";
      },
    });
    old = new ClassicLevel<string, unknown>(copy, { valueEncoding: "json" });
    await old.open();
    let games = 0,
      paths = 0;
    const oldGames = old.sublevel<string, Game>(levelKeys.games, {
      valueEncoding: "json",
    });
    for await (const [key, value] of oldGames.iterator()) {
      GoogleDriveAuth.assert(session);
      if (
        !value ||
        typeof value.objectId !== "string" ||
        key !== levelKeys.game(value.shop, value.objectId)
      )
        continue;
      if (await gamesSublevel.get(key)) continue;
      await gamesSublevel.put(key, {
        ...value,
        remoteId: null,
        automaticCloudSync: false,
      });
      games++;
    }
    const oldEmulators = old.sublevel<EmulatorSystem, EmulatorConfig>(
      levelKeys.emulators,
      { valueEncoding: "json" }
    );
    for await (const [key, value] of oldEmulators.iterator()) {
      GoogleDriveAuth.assert(session);
      if (!(await emulatorsSublevel.get(key)))
        await emulatorsSublevel.put(key, value);
    }
    const oldPaths = old.sublevel<string, unknown>(
      levelKeys.cloudSaveCustomPaths,
      { valueEncoding: "json" }
    );
    for await (const [key, value] of oldPaths.iterator()) {
      GoogleDriveAuth.assert(session);
      const parsed = JSON.parse(key);
      if (!Array.isArray(parsed) || parsed.length !== 3) continue;
      const destination = JSON.stringify([
        `google:${session.accountId}`,
        parsed[1],
        parsed[2],
      ]);
      if (await cloudSaveCustomPathsSublevel.get(destination)) continue;
      const bindings = normalizeStoredCloudSaveCustomPathEntries(value).map(
        (entry) => ({ ...entry, syncState: "pending" as const })
      );
      if (bindings.length) {
        await cloudSaveCustomPathsSublevel.put(destination, bindings);
        paths += bindings.length;
      }
    }
    WindowManager.sendToAppWindows("on-library-batch-complete");
    return { games, paths };
  } finally {
    await old?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
