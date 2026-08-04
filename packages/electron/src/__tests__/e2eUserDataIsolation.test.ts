// @vitest-environment node
/**
 * Guard: the E2E launcher must never point Electron at the developer's real
 * userData directory.
 *
 * `PLAYWRIGHT=1` only redirects the *database* (see `database/initialize.ts`)
 * and the extensions folder. Everything else `app.getPath('userData')` backs --
 * `app-settings.json`, `workspace-settings.json`, `ai-settings.json`,
 * `terminal-store.json`, `stytch-*.enc` -- resolves to the real directory
 * unless `NIMBALYST_USER_DATA_DIR` is set (see `main/bootstrap.ts`).
 *
 * Because `allowMultipleInstances` is also true under `PLAYWRIGHT`
 * (`main/index.ts`), a test run launches *alongside* the developer's running
 * dev instance and both electron-store instances read-modify-write the same
 * `app-settings.json`. That is how a test run can silently rewrite real
 * settings (sync config, signed-in accounts, open workspaces).
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { buildTestEnv } from '../../e2e/helpers';

const REAL_USER_DATA_FRAGMENT = path.join('@nimbalyst', 'electron');

describe('E2E launcher userData isolation', () => {
  it('pins Electron at an isolated temp userData directory', () => {
    const env = buildTestEnv('http://127.0.0.1:5273');

    expect(env.NIMBALYST_USER_DATA_DIR).toBeTruthy();
    expect(env.NIMBALYST_USER_DATA_DIR!.startsWith(os.tmpdir())).toBe(true);
    expect(env.NIMBALYST_USER_DATA_DIR).not.toContain(REAL_USER_DATA_FRAGMENT);
  });

  it('lets a spec opt into its own userData directory', () => {
    const mine = path.join(os.tmpdir(), 'nimbalyst-spec-scoped-user-data');
    const env = buildTestEnv('http://127.0.0.1:5273', {
      env: { NIMBALYST_USER_DATA_DIR: mine },
    });

    expect(env.NIMBALYST_USER_DATA_DIR).toBe(mine);
  });

  it('does not inherit a NIMBALYST_USER_DATA_DIR pointing at real user data', () => {
    // A worktree dev shell can export NIMBALYST_USER_DATA_DIR; `buildTestEnv`
    // spreads `process.env`, so the default must win over the inherited value
    // unless the spec asked for a specific directory.
    const previous = process.env.NIMBALYST_USER_DATA_DIR;
    process.env.NIMBALYST_USER_DATA_DIR = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      '@nimbalyst',
      'electron',
    );
    try {
      const env = buildTestEnv('http://127.0.0.1:5273');
      expect(env.NIMBALYST_USER_DATA_DIR).not.toContain(REAL_USER_DATA_FRAGMENT);
    } finally {
      if (previous === undefined) delete process.env.NIMBALYST_USER_DATA_DIR;
      else process.env.NIMBALYST_USER_DATA_DIR = previous;
    }
  });
});
