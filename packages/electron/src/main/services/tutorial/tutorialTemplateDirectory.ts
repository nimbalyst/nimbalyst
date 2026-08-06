import { app } from "electron";
import * as path from "path";
import { getPackageRoot } from "../../utils/appPaths";

/**
 * Resolve the tutorial template without touching app paths at module load time.
 *
 * Dev must go through getPackageRoot(), not app.getAppPath(): under the vite
 * dev build getAppPath() points at `out/main` (or `out2/main` for dev:user2),
 * so joining `resources/` onto it resolves to a directory that does not exist
 * and "Start tutorial" fails before it copies anything.
 */
export function getTutorialTemplateDirectory(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "tutorial-project");
  }

  return path.join(getPackageRoot(), "resources", "tutorial-project");
}
