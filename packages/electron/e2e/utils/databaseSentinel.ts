/**
 * A uniquely identifiable piece of user data, written and read back through the
 * production IPC surface.
 *
 * Why this exists: two review rounds on the migration/recovery work returned
 * "not safe to ship" with green unit tests, because the tests asserted against
 * injected fakes. `pglite-db/` existing on disk, `database-backend.json` saying
 * `sqlite`, and `.workspace-sidebar` appearing are all things that stay true
 * when the database underneath them is empty. Safety invariant 10 of
 * `pglite-to-sqlite-migration-retry.md` says so directly: "a green migration
 * test must prove preservation of known user data through restart; directory
 * existence and app readiness are insufficient."
 *
 * So every assertion in the database-lifecycle specs comes back to: is the row
 * this app wrote through `sessions:create` and `history:create-snapshot` still
 * readable through `sessions:get` and `history:load-snapshot`, after whatever
 * the spec did to the disk in between.
 *
 * The history snapshot carries the weight. It is gzip-compressed into a bytea
 * (PGLite) / BLOB (SQLite) column and decompressed on read, so a byte-exact
 * readback of a random string is evidence the migration moved the bytes, not
 * just the row count.
 */

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * One directory for the database, the backend flag, the recovery journal, the
 * recovery artifacts AND electron-store.
 *
 * Production keeps all of these in `userData`, and several of the code paths
 * under test read across that boundary: `countConfiguredProjects` reads
 * `workspace-settings.json` from the same directory it scans for
 * `pglite-db.backup-*`, and it is the one fact the recovery recommendation
 * takes from outside the two databases. The default E2E layout splits them --
 * the database goes to `nimbalyst-test-db` under `PLAYWRIGHT=1` while
 * `userData` goes to `nimbalyst-test-user-data` -- which would make every
 * recovery assessment read a settings file that is not next to the artifact.
 *
 * `NIMBALYST_USER_DATA_PATH` is the existing production override (see
 * `initialize.ts`, `productionRecovery.ts`, `MigrationHandlers.ts`);
 * `NIMBALYST_USER_DATA_DIR` is the one `bootstrap.ts` reads. Pointing both at
 * one directory reproduces the production layout exactly.
 */
export const DB_LIFECYCLE_DIR = path.join(os.tmpdir(), 'nimbalyst-db-lifecycle');

export const FLAG_FILE = path.join(DB_LIFECYCLE_DIR, 'database-backend.json');
export const PGLITE_DIR = path.join(DB_LIFECYCLE_DIR, 'pglite-db');
export const SQLITE_DIR = path.join(DB_LIFECYCLE_DIR, 'sqlite-db');
export const RECOVERY_JOURNAL = path.join(DB_LIFECYCLE_DIR, 'database-recovery.json');

/** Env every launch in these specs must use, so all of the above line up. */
export const DB_LIFECYCLE_ENV: Record<string, string> = {
  NIMBALYST_USER_DATA_DIR: DB_LIFECYCLE_DIR,
  NIMBALYST_USER_DATA_PATH: DB_LIFECYCLE_DIR,
};

/** Wipe the whole install. Guarded to the system temp directory. */
export function resetDbLifecycleDir(): void {
  const resolved = path.resolve(DB_LIFECYCLE_DIR);
  const tmp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tmp + path.sep)) {
    throw new Error(`Refusing to remove ${resolved}: it is not under ${tmp}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  fs.mkdirSync(resolved, { recursive: true });
}

export function readFlag(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(FLAG_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function dirsMatching(prefix: string): string[] {
  try {
    return fs.readdirSync(DB_LIFECYCLE_DIR).filter((d) => d.startsWith(prefix));
  } catch {
    return [];
  }
}

/**
 * Pin the next launch to PGLite.
 *
 * `rollback` is the one `setBy` the selector never treats as migration-due, so
 * the app opens PGLite and builds a real store instead of resolving a fresh
 * install to SQLite.
 */
export function pinToPglite(): void {
  fs.mkdirSync(DB_LIFECYCLE_DIR, { recursive: true });
  fs.writeFileSync(
    FLAG_FILE,
    JSON.stringify({ backend: 'pglite', setAt: new Date().toISOString(), setBy: 'rollback' }),
  );
}

/**
 * Make sure the install looks like one that has been used, from outside both
 * databases.
 *
 * `assessRecoveryCandidate` will not recommend recovery on an install with no
 * configured projects -- deliberately, because "empty because it is new" and
 * "empty because it was wiped" are otherwise indistinguishable. The app writes
 * this itself when a workspace is opened; this only backfills when a launch did
 * not get that far, so a spec never fails on a settings file instead of on the
 * behaviour it is testing.
 */
export function ensureConfiguredProject(workspace: string): void {
  const settingsPath = path.join(DB_LIFECYCLE_DIR, 'workspace-settings.json');
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed;
  } catch {
    // No settings yet.
  }
  if (Object.keys(current).length > 0) return;
  current[workspace] = { lastOpened: new Date().toISOString() };
  fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// The sentinel itself
// ---------------------------------------------------------------------------

export interface DatabaseSentinel {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  /** Absolute path of the document the history snapshot belongs to. */
  filePath: string;
  /** Random, so a readback of it cannot come from anywhere but this write. */
  content: string;
}

export function makeSentinel(workspace: string): DatabaseSentinel {
  const nonce = randomUUID();
  const filePath = path.join(workspace, 'sentinel.md');
  return {
    sessionId: `sentinel-session-${nonce}`,
    sessionTitle: `Sentinel ${nonce}`,
    workspaceId: workspace,
    filePath,
    content: `# Sentinel\n\nnonce=${nonce}\n${'payload '.repeat(64)}\n`,
  };
}

/** Create the document on disk so the snapshot describes a file that exists. */
export function writeSentinelFile(sentinel: DatabaseSentinel): void {
  fs.writeFileSync(sentinel.filePath, sentinel.content, 'utf-8');
}

/**
 * Write the sentinel through the same IPC the app itself uses: `sessions:create`
 * is what the New Session button calls, `history:create-snapshot` is what a save
 * calls. Nothing here reaches into the database directly.
 */
export async function writeSentinel(page: Page, sentinel: DatabaseSentinel): Promise<void> {
  const result = await page.evaluate(async (s) => {
    const api = (window as { electronAPI?: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).electronAPI;
    if (!api) return { created: null, error: 'no electronAPI' };
    try {
      const created = await api.invoke('sessions:create', {
        session: { id: s.sessionId, title: s.sessionTitle, provider: 'claude', mode: 'agent' },
        workspaceId: s.workspaceId,
        launchSource: 'e2e-database-sentinel',
      });
      await api.invoke('history:create-snapshot', s.filePath, s.content, 'manual', s.sessionTitle);
      return { created, error: null };
    } catch (err) {
      return { created: null, error: String(err) };
    }
  }, sentinel);

  expect(result.error, 'writing the sentinel through production IPC').toBeNull();
  expect(result.created).toMatchObject({ success: true });
}

export interface SentinelReadback {
  /** Title read back through `sessions:get`, or null when the row is gone. */
  sessionTitle: string | null;
  snapshotCount: number;
  /** Byte-exact content read back through `history:load-snapshot`. */
  content: string | null;
  errors: string[];
}

/**
 * Read the sentinel back through the production query path for whichever
 * backend is live. Never throws: a spec asserting that data survived needs to
 * be able to say "it did not" rather than dying inside `page.evaluate`.
 */
export async function readSentinel(page: Page, sentinel: DatabaseSentinel): Promise<SentinelReadback> {
  return page.evaluate(async (s) => {
    const api = (window as { electronAPI?: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).electronAPI;
    const out = { sessionTitle: null as string | null, snapshotCount: 0, content: null as string | null, errors: [] as string[] };
    if (!api) {
      out.errors.push('no electronAPI');
      return out;
    }
    try {
      const got = await api.invoke('sessions:get', s.sessionId) as { session?: { title?: string } | null };
      out.sessionTitle = got?.session?.title ?? null;
    } catch (err) {
      out.errors.push(`sessions:get ${String(err)}`);
    }
    try {
      const snaps = await api.invoke('history:list-snapshots', s.filePath) as Array<{ timestamp: string }>;
      out.snapshotCount = Array.isArray(snaps) ? snaps.length : 0;
      if (Array.isArray(snaps) && snaps.length > 0) {
        out.content = await api.invoke('history:load-snapshot', s.filePath, snaps[0].timestamp) as string;
      }
    } catch (err) {
      out.errors.push(`history ${String(err)}`);
    }
    return out;
  }, sentinel);
}

/** The whole point of the spec suite, in one call. */
export function expectSentinelIntact(
  readback: SentinelReadback,
  sentinel: DatabaseSentinel,
  when: string,
): void {
  expect(readback.sessionTitle, `${when}: the sentinel AI session`).toBe(sentinel.sessionTitle);
  expect(readback.snapshotCount, `${when}: the sentinel document history`).toBeGreaterThan(0);
  expect(readback.content, `${when}: the sentinel document body, byte for byte`).toBe(sentinel.content);
}
