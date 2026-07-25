import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { prebuildsForTarget, pruneSqlitePrebuilds } = require_('../afterPack.js');

const ALL_PREBUILDS = [
  'darwin-arm64.node',
  'darwin-x64.node',
  'linux-arm64.node',
  'linux-x64.node',
  'linuxmusl-arm64.node',
  'linuxmusl-x64.node',
  'win32-arm64.node',
  'win32-x64.node',
];

const created: string[] = [];
afterEach(() => {
  while (created.length) fs.rmSync(created.pop()!, { recursive: true, force: true });
});

function makeResources(options: { prebuilds?: string[]; legacyBinary?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-afterpack-'));
  created.push(root);
  const prebuildsDir = path.join(root, 'node_modules/better-sqlite3/prebuilds');
  fs.mkdirSync(prebuildsDir, { recursive: true });
  for (const name of options.prebuilds ?? ALL_PREBUILDS) {
    fs.writeFileSync(path.join(prebuildsDir, name), 'x'.repeat(1024));
  }
  if (options.legacyBinary) {
    const releaseDir = path.join(root, 'node_modules/better-sqlite3/build/Release');
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(path.join(releaseDir, 'better_sqlite3.node'), '');
  }
  return root;
}

function remaining(root: string): string[] {
  return fs.readdirSync(path.join(root, 'node_modules/better-sqlite3/prebuilds')).sort();
}

describe('prebuildsForTarget', () => {
  it('keeps one prebuild for a single-arch mac target', () => {
    expect([...prebuildsForTarget('darwin', 'arm64')]).toEqual(['darwin-arm64.node']);
  });

  it('keeps both slices for a universal mac target', () => {
    expect([...prebuildsForTarget('darwin', 'universal')].sort())
      .toEqual(['darwin-arm64.node', 'darwin-x64.node']);
  });

  it('keeps the musl variant alongside glibc on linux', () => {
    expect([...prebuildsForTarget('linux', 'x64')].sort())
      .toEqual(['linux-x64.node', 'linuxmusl-x64.node']);
  });

  it('uses the win32 prefix that better-sqlite3 actually ships', () => {
    expect([...prebuildsForTarget('win32', 'x64')]).toEqual(['win32-x64.node']);
  });
});

describe('pruneSqlitePrebuilds', () => {
  it('leaves only the target prebuild in a mac bundle', () => {
    const root = makeResources();
    const result = pruneSqlitePrebuilds(root, 'darwin', 'arm64');
    expect(remaining(root)).toEqual(['darwin-arm64.node']);
    expect(result).toMatchObject({ removedCount: 7, keptCount: 1 });
  });

  it('keeps glibc and musl variants for a linux bundle', () => {
    const root = makeResources();
    pruneSqlitePrebuilds(root, 'linux', 'x64');
    expect(remaining(root)).toEqual(['linux-x64.node', 'linuxmusl-x64.node']);
  });

  it('throws rather than shipping a bundle with no loadable binary', () => {
    // Simulates a better-sqlite3 bump that renames the prebuilds: every file
    // would be pruned, and the app could not open its database.
    const root = makeResources({ prebuilds: ['darwin-arm64-napi-v9.node'] });
    expect(() => pruneSqlitePrebuilds(root, 'darwin', 'arm64')).toThrow(/pruned every better-sqlite3 prebuild/);
  });

  it('tolerates a zero-match prune when a source-built binary is present', () => {
    const root = makeResources({ prebuilds: ['linux-x64.node'], legacyBinary: true });
    expect(() => pruneSqlitePrebuilds(root, 'darwin', 'arm64')).not.toThrow();
    expect(remaining(root)).toEqual([]);
  });

  it('is a no-op when the package was not copied into resources', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-afterpack-empty-'));
    created.push(root);
    expect(pruneSqlitePrebuilds(root, 'darwin', 'arm64')).toMatchObject({ skipped: true });
  });
});
