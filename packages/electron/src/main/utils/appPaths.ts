import { app } from 'electron';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

/**
 * Get the package root directory (the one containing package.json).
 *
 * In dev mode with the default outDir, app.getAppPath() returns the package root.
 * With an alternate outDir (e.g. out2/main for a second dev instance),
 * app.getAppPath() returns something like <root>/out2/main, so we walk up.
 */
export function getPackageRoot(): string {
  const appPath = app.getAppPath();
  if (app.isPackaged) return appPath;

  // Already at the package root
  if (existsSync(join(appPath, 'package.json'))) return appPath;

  // Walk up from out*/main to find the package root
  let dir = appPath;
  while (dir !== dirname(dir)) {
    dir = dirname(dir);
    if (existsSync(join(dir, 'package.json'))) return dir;
  }

  // Fallback
  return appPath;
}

/**
 * Resolve the preload script path.
 * The preload is always built to <outDir>/preload/index.js.
 * With the default outDir that's out/preload/index.js.
 * With an alternate outDir (out2), it's out2/preload/index.js.
 */
export function getPreloadPath(): string {
  const appPath = app.getAppPath();
  if (app.isPackaged) return join(appPath, 'out/preload/index.js');

  // If appPath is already the package root, preload is at out/preload/index.js
  if (existsSync(join(appPath, 'package.json'))) {
    return join(appPath, 'out/preload/index.js');
  }

  // appPath is inside an outDir (e.g. out2/main) -- preload is a sibling of main
  return join(appPath, '../preload/index.js');
}

/**
 * Get the path for the restart signal file used by dev-loop.sh.
 * Uses a per-instance suffix when NIMBALYST_USER_DATA_DIR is set
 * so multiple dev-loop instances don't cross-talk.
 */
export function getRestartSignalPath(): string {
  const root = getPackageRoot();
  const customDir = process.env.NIMBALYST_USER_DATA_DIR;
  if (customDir) {
    const suffix = customDir.split(/[/\\]/).pop() || '';
    return join(root, `.restart-requested-${suffix}`);
  }
  return join(root, '.restart-requested');
}
