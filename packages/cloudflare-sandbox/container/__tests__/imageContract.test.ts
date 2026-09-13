// @vitest-environment node
/**
 * The build-context allowlist decides what may enter a layer that ships to
 * Cloudflare, and its dangerous failure is a policy that quietly says "copy".
 * Nothing about a successful `docker build` would reveal that, which is why the
 * policy is pure functions over names and paths, tested here.
 *
 * The Dockerfile's version pins are checked by `checks/image-pins.test.mjs`
 * (`node --test`), not here: they are text assertions over a config file, which
 * belongs in a gate rather than in the unit suite every session pays to load.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyEntry,
  expandWorkspaceGlobs,
  isSecretFileName,
  normalizeStagedPath,
} from '../buildContextAllowlist.mjs';

describe('build context allowlist', () => {
  it('refuses credential-shaped files instead of skipping them', () => {
    for (const name of ['.env', '.env.local', '.npmrc', 'id_rsa', 'server.pem', 'team-secrets.json']) {
      expect(isSecretFileName(name), name).toBe(true);
      expect(classifyEntry({ name, isDirectory: false }), name).toBe('reject');
    }
    expect(classifyEntry({ name: 'SessionManager.ts', isDirectory: false })).toBe('copy');
  });

  it('never descends into installed, built, or private directories', () => {
    for (const name of ['node_modules', '.git', 'dist', 'dist-node', '__tests__', 'temptests']) {
      expect(classifyEntry({ name, isDirectory: true }), name).toBe('skip');
    }
    expect(classifyEntry({ name: 'providers', isDirectory: true })).toBe('copy');
  });

  it('rejects paths that would escape the repository or reach private trees', () => {
    expect(() => normalizeStagedPath('/etc/passwd')).toThrow(/absolute/);
    expect(() => normalizeStagedPath('packages/../../secrets')).toThrow(/escapes/);
    expect(() => normalizeStagedPath('nimbalyst-local/CURRENT_FOCUS.md')).toThrow(/private/);
    expect(() => normalizeStagedPath('node_modules/better-sqlite3')).toThrow(/private/);
    expect(normalizeStagedPath('packages/node/src')).toBe('packages/node/src');
  });

  it('expands the workspace globs npm validates the lockfile against', () => {
    const listed = expandWorkspaceGlobs(
      ['packages/runtime', 'packages/extensions/*'],
      (parent) => (parent === 'packages/extensions' ? ['nimbalyst-memory', 'nimbalyst-slides'] : []),
    );
    expect(listed).toEqual([
      'packages/runtime',
      'packages/extensions/nimbalyst-memory',
      'packages/extensions/nimbalyst-slides',
    ]);
    expect(() => expandWorkspaceGlobs(['packages/**/deep'], () => [])).toThrow(/unsupported/);
  });
});
