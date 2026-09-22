import { app, dialog } from "electron";
import path from "node:path";
import { logger } from "./logger";

export class SystemPath {
  static readonly paths = {
    userData: "userData",
    downloads: "downloads",
    documents: "documents",
    desktop: "desktop",
    home: "home",
    appData: "appData",
    temp: "temp",
  };

  static checkIfPathsAreAvailable() {
    const paths = Object.keys(
      SystemPath.paths
    ) as (keyof typeof SystemPath.paths)[];

    paths.forEach((pathName) => {
      try {
        app.getPath(pathName);
      } catch (error) {
        logger.error(`Error getting path ${pathName}`);
        if (error instanceof Error) {
          logger.error(error.message, error.stack);
        }

        dialog.showErrorBox(
          `Hydra was not able to find path for '${pathName}' system folder`,
          `Some functionalities may not work as expected.\nPlease check your system settings.`
        );
      }
    });
  }

  static getPath(pathName: keyof typeof SystemPath.paths): string {
    try {
      if (pathName === "userData") {
        // Honor Electron's standard profile override for portable use and
        // isolated packaged qualification without touching the normal profile.
        const override = app.commandLine.getSwitchValue("user-data-dir");
        if (override && path.isAbsolute(override)) return override;
        return path.join(app.getPath("appData"), "Hydra Drive");
      }
      return app.getPath(pathName);
    } catch (error) {
      console.error(`Error getting path: ${error}`);
      return "";
    }
  }
}
