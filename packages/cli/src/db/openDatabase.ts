/**
 * Open a better-sqlite3 handle, honoring NIMBALYST_BETTER_SQLITE3_NATIVE.
 *
 * The hoisted better-sqlite3 build targets Electron's ABI (the desktop app is
 * the primary consumer). Vitest's globalSetup fetches a Node-ABI prebuild and
 * points this env var at it so CLI tests can load the binary under the system
 * Node that vitest runs against -- otherwise `new Database()` throws
 * NODE_MODULE_VERSION / "Module did not self-register". In production the env is
 * unset and this is a plain `new Database()`. Mirrors SQLiteDatabase.ts.
 */
import Database from 'better-sqlite3';

export function openDatabase(
  path: string,
  options: Database.Options = {},
): Database.Database {
  const nativeBinding = process.env.NIMBALYST_BETTER_SQLITE3_NATIVE || undefined;
  return new Database(path, nativeBinding ? { ...options, nativeBinding } : options);
}
