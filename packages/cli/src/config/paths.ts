/**
 * Platform-aware resolution of Nimbalyst's on-disk locations, mirroring how the
 * Electron app derives `app.getPath('userData')` so the CLI reads the same files
 * the app writes.
 *
 * App name is `@nimbalyst/electron` (see packages/electron/package.json `name`),
 * which is what Electron uses to build the userData directory.
 */
import * as os from 'os';
import * as path from 'path';

const APP_NAME = '@nimbalyst/electron';

/**
 * The Nimbalyst userData directory.
 *
 * Honors `NIMBALYST_USER_DATA_DIR` (the same override the app's bootstrap.ts
 * respects for dev:user2 / worktrees), then falls back to the platform default.
 */
export function resolveUserDataDir(): string {
  const override = process.env.NIMBALYST_USER_DATA_DIR || process.env.NIMBALYST_USER_DATA_PATH;
  if (override) return override;

  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
    default: {
      // Linux / other: XDG_CONFIG_HOME or ~/.config
      const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
      return path.join(xdg, APP_NAME);
    }
  }
}

/** Absolute path to the better-sqlite3 database file (honors NIM_DB). */
export function resolveSqlitePath(): string {
  if (process.env.NIM_DB) return process.env.NIM_DB;
  return resolveDefaultSqlitePath();
}

/**
 * The platform-default database path the running app actually uses, ignoring the
 * NIM_DB override. The offline-write live-guard compares against THIS (not
 * `resolveSqlitePath`) so that pointing the CLI at a scratch DB via NIM_DB while
 * the app runs on its real DB isn't falsely refused — the app only ever owns the
 * canonical file.
 */
export function resolveDefaultSqlitePath(): string {
  return path.join(resolveUserDataDir(), 'sqlite-db', 'nimbalyst.sqlite');
}

/** Absolute path to the live-mode endpoint descriptor the app writes at startup. */
export function resolveEndpointDescriptorPath(): string {
  return path.join(resolveUserDataDir(), 'mcp-endpoint.json');
}

/** Absolute path to the electron-store app-settings file (recent workspaces, etc.). */
export function resolveAppSettingsPath(): string {
  return path.join(resolveUserDataDir(), 'app-settings.json');
}
