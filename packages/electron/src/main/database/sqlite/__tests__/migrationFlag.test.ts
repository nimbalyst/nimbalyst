// @vitest-environment node
/**
 * The production authorization path, end to end from the config source to the
 * decision.
 *
 * `rolloutAuthorization.test.ts` proves the evaluation rules. This file proves
 * the wiring: which source a launch reads, and that the on-disk cache is never
 * an input.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Narrow module mocks: the things `migrationFlag` reaches into. None pulls in
// the runtime barrel.
vi.mock('../../../utils/store', () => ({
  getReleaseChannel: () => 'alpha',
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: () => {}, warn: () => {}, error: () => {} } },
}));

import {
  authorizeRollout,
  cacheRolloutSnapshot,
  readCachedRolloutSnapshot,
  selectRolloutConfigSource,
  TEST_ROLLOUT_PAYLOAD_ENV,
} from '../migrationFlag';
import { readBackendState, writeBackendState } from '../BackendSelector';
import {
  assessCohort,
  BUILT_IN_CONFIG_VERSION,
  BUILT_IN_MAX_SOURCE_BYTES,
  type RolloutSnapshot,
} from '../rolloutAuthorization';

const GIB = 1024 * 1024 * 1024;

let tmp: string;

/** Deliberately far-future, so nothing here passes merely by expiring. */
function cachedEnable(): RolloutSnapshot {
  return {
    enabled: true,
    maxSourceBytes: 268435456, // 256 MiB
    releaseChannel: 'alpha',
    configVersion: 'sqlite-ramp-1',
    fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-rollout-flag-'));
  writeBackendState(tmp, {
    backend: 'pglite',
    setAt: new Date().toISOString(),
    setBy: 'auto-migration-deferred',
    rolloutSnapshot: cachedEnable(),
  });
  vi.stubEnv('PLAYWRIGHT', '');
  vi.stubEnv(TEST_ROLLOUT_PAYLOAD_ENV, '');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('authorizeRollout on a production launch', () => {
  it('authorizes the built-in 1 GiB configuration without asking any remote service', async () => {
    // The PostHog flags are gone; the build itself is the authorization.
    const result = await authorizeRollout(tmp);

    expect(result).toMatchObject({
      authorized: true,
      snapshot: {
        enabled: true,
        releaseChannel: 'alpha',
        configVersion: BUILT_IN_CONFIG_VERSION,
        maxSourceBytes: BUILT_IN_MAX_SOURCE_BYTES,
      },
    });
  });

  it('migrates sources up to 1 GiB automatically and offers consent above it', async () => {
    const result = await authorizeRollout(tmp);
    if (!result.authorized) throw new Error('expected the built-in configuration to authorize');

    expect(assessCohort(512 * 1024 * 1024, result.snapshot)).toEqual({ withinCohort: true });
    expect(assessCohort(GIB, result.snapshot)).toEqual({ withinCohort: true });
    expect(assessCohort(GIB + 1, result.snapshot)).toEqual({
      withinCohort: false,
      reason: 'source_above_ceiling',
    });
  });
});

describe('the Playwright payload file', () => {
  it('is ignored unless PLAYWRIGHT=1, so the path variable alone cannot change the configuration', async () => {
    const file = path.join(tmp, 'rollout-payloads.json');
    fs.writeFileSync(file, JSON.stringify({ 'sqlite-rollout-alpha': cachedEnable() }));

    const withoutPlaywright = selectRolloutConfigSource({ [TEST_ROLLOUT_PAYLOAD_ENV]: file }, 'alpha');
    expect(await withoutPlaywright.fetchPayload('sqlite-rollout-alpha')).toMatchObject({
      configVersion: BUILT_IN_CONFIG_VERSION,
    });

    const underPlaywright = selectRolloutConfigSource({ PLAYWRIGHT: '1', [TEST_ROLLOUT_PAYLOAD_ENV]: file }, 'alpha');
    expect(await underPlaywright.fetchPayload('sqlite-rollout-alpha')).toMatchObject({ configVersion: 'sqlite-ramp-1' });
    expect(await underPlaywright.fetchPayload('sqlite-rollout-stable')).toBeNull();
  });

  it('authorizes nothing under Playwright without a payload file, so other E2E specs never migrate', async () => {
    vi.stubEnv('PLAYWRIGHT', '1');

    const result = await authorizeRollout(tmp);

    expect(result).toEqual({ authorized: false, reason: 'authorization_unavailable' });
    // The cache is still not an input, even though it holds an enabled,
    // unexpired snapshot.
    expect(readCachedRolloutSnapshot(tmp)?.enabled).toBe(true);
  });
});

describe('the rollout snapshot cache', () => {
  it('round-trips without disturbing the backend the install resolved to', () => {
    // The cache lives in the same file as the backend selection, and a write
    // that clobbered `backend` is exactly how #1347 pinned installs to a
    // database they should never have had.
    cacheRolloutSnapshot(tmp, { ...cachedEnable(), configVersion: 'sqlite-ramp-2' });

    expect(readCachedRolloutSnapshot(tmp)?.configVersion).toBe('sqlite-ramp-2');
    expect(readBackendState(tmp)?.backend).toBe('pglite');
    expect(readBackendState(tmp)?.setBy).toBe('auto-migration-deferred');
  });
});
