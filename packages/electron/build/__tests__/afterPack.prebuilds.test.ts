// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const { prebuildsForTarget, pruneSqlitePrebuilds, pruneNodePtyPrebuilds } =
  require_('../afterPack.js');

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

// node-pty's extraResources copy takes the whole package, so every build
// carried the other platforms' prebuilds. On Windows those Mach-O pty.node
// files failed the release workflow's Authenticode sweep and killed the
// v0.72.0 build after its tag had already been pushed.
const ALL_PTY_PREBUILDS = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'];

function makePtyResources(
  options: { prebuilds?: string[]; sourceBuilt?: boolean } = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-afterpack-pty-'));
  created.push(root);
  for (const name of options.prebuilds ?? ALL_PTY_PREBUILDS) {
    const dir = path.join(root, 'node-pty/prebuilds', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pty.node'), 'x'.repeat(1024));
  }
  if (options.sourceBuilt) {
    const releaseDir = path.join(root, 'node-pty/build/Release');
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(path.join(releaseDir, 'pty.node'), '');
  }
  return root;
}

function remainingPty(root: string): string[] {
  return fs.readdirSync(path.join(root, 'node-pty/prebuilds')).sort();
}

describe('pruneNodePtyPrebuilds', () => {
  it('strips the Mach-O prebuilds from a Windows payload', () => {
    const root = makePtyResources();
    const result = pruneNodePtyPrebuilds(root, 'win32', 'x64');
    expect(remainingPty(root)).toEqual(['win32-x64']);
    expect(result).toMatchObject({ removedCount: 3, keptCount: 1 });
  });

  it('keeps both slices for a universal mac target', () => {
    const root = makePtyResources();
    pruneNodePtyPrebuilds(root, 'darwin', 'universal');
    expect(remainingPty(root)).toEqual(['darwin-arm64', 'darwin-x64']);
  });

  it('tolerates linux, which is source-built rather than prebuilt', () => {
    const root = makePtyResources({ sourceBuilt: true });
    expect(() => pruneNodePtyPrebuilds(root, 'linux', 'x64')).not.toThrow();
    expect(remainingPty(root)).toEqual([]);
  });

  it('throws rather than shipping a build with no loadable pty binary', () => {
    // Simulates a node-pty bump that renames the prebuild dirs: every dir
    // would be pruned and the app could not start a terminal.
    const root = makePtyResources({ prebuilds: ['win32-x64-napi-v3'] });
    expect(() => pruneNodePtyPrebuilds(root, 'win32', 'x64')).toThrow(
      /pruned every node-pty prebuild/,
    );
  });

  it('is a no-op when node-pty was not copied into resources', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-afterpack-pty-empty-'));
    created.push(root);
    expect(pruneNodePtyPrebuilds(root, 'darwin', 'arm64')).toMatchObject({ skipped: true });
  });
});
