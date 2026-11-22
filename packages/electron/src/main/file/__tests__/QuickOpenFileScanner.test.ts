// @vitest-environment node
/**
 * #1449: a clone nested in a workspace repo is normally ignored by that repo,
 * and the ripgrep scan behind Quick Open and @ mentions honored the ignore rule,
 * so none of the clone's files could be found. Runs the real git and ripgrep
 * binaries against an on-disk fixture, because the behavior lives entirely in
 * how those two read ignore rules and `.git` entries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { rgPath } from '@vscode/ripgrep';
import { assertGitSandbox, FIXTURE_IDENTITY_ARGS, gitSandboxEnv } from '../../services/testSupport/gitTestSandbox';
import { QUICKOPEN_FILE_TYPE_ARGS, RIPGREP_EXCLUDE_ARGS_ARRAY } from '../../utils/fileFilters';

vi.mock('../../services/ripgrepPath', async importOriginal => ({
  ...await importOriginal<typeof import('../../services/ripgrepPath')>(),
  getRipgrepPath: () => rgPath,
}));

import { buildQuickOpenCacheForRoot, findWorkspaceFiles, listContentSearchRoots, searchFileContent } from '../QuickOpenFileScanner';

let tmpRoot: string;
let outer: string;
let inner: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: gitSandboxEnv() });
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function initRepo(dir: string, files: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  git(['init'], dir);
  assertGitSandbox(dir);
  for (const [name, content] of Object.entries(files)) write(path.join(dir, name), content);
  git(['add', '.'], dir);
  git([...FIXTURE_IDENTITY_ARGS, 'commit', '-m', 'init'], dir);
}

beforeEach(() => {
  tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nim-quickopen-nested-')));
  outer = path.join(tmpRoot, 'outer');
  inner = path.join(outer, 'inner');

  initRepo(outer, {
    'README.md': '# outer\n',
    '.gitignore': '/inner/\n/generated/\n/snapshot/\n/mirror/\n',
  });
  // The clone the outer repo ignores, with an ignore rule of its own.
  initRepo(inner, { 'src/app.ts': 'export {};\n', '.gitignore': 'tmp/\n' });
  write(path.join(inner, 'tmp', 'cache.txt'), 'ignored by inner\n');
  // Ignored output that is not a checkout.
  write(path.join(outer, 'generated', 'out.txt'), 'build output\n');
  // A linked worktree of the outer repo: only a second copy of its own files.
  git(['worktree', 'add', '-b', 'snapshot', path.join(outer, 'snapshot')], outer);
  // A linked worktree of the inner repo, placed inside the outer one.
  git(['worktree', 'add', '-b', 'mirror', path.join(outer, 'mirror')], inner);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function relativeTo(root: string, files: string[]): string[] {
  return files.map(file => path.relative(root, file).split(path.sep).join('/')).sort();
}

describe('findWorkspaceFiles with nested repositories (#1449)', () => {
  it('lists files of clones the root ignores, under each clone own ignore rules', async () => {
    const files = relativeTo(outer, await findWorkspaceFiles(outer));

    expect(files).toEqual(expect.arrayContaining([
      'README.md',
      'inner/src/app.ts',
      'mirror/src/app.ts',
    ]));
    expect(files).not.toContain('inner/tmp/cache.txt');
    expect(files).not.toContain('generated/out.txt');
    expect(files.filter(file => file.startsWith('snapshot/'))).toEqual([]);
  });

  it('returns content matches once when a nested clone is also a root, respecting its ignore rules', async () => {
    const needle = 'nested-search-regression';
    write(path.join(inner, 'src', 'content.md'), `${needle}\n`);
    write(path.join(inner, 'tmp', 'ignored.md'), `${needle}\n`);
    write(path.join(outer, 'generated', 'ignored.md'), `${needle}\n`);
    const roots = await listContentSearchRoots([outer, inner]);

    expect(roots).toEqual([outer, inner, path.join(outer, 'mirror')]);
    // Exercise the argument shapes used by both content-search handlers.
    for (const types of [QUICKOPEN_FILE_TYPE_ARGS, ['--type', 'md']]) {
      const stdout = execFileSync(rgPath, [
        ...types, '-i', '--json', ...RIPGREP_EXCLUDE_ARGS_ARRAY, needle, ...roots,
      ], { encoding: 'utf8' });
      const matches = stdout.trim().split('\n').map(line => JSON.parse(line))
        .filter(item => item.type === 'match');
      expect(matches.map(item => path.normalize(item.data.path.text)))
        .toEqual([path.join(inner, 'src', 'content.md')]);
      expect(matches[0].data.lines.text).toBe(`${needle}\n`);
    }
  });
});

describe('large workspaces', () => {
  const OLD_BUFFER_CAP = 5 * 1024 * 1024;

  it('indexes a root whose file listing is larger than the old 5MB buffer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nimbalyst-quickopen-large-'));
    try {
      const dir = path.join(root, 'd'.repeat(200));
      await mkdir(dir);
      const names = Array.from({ length: 12_000 }, (_, i) => `${String(i).padStart(5, '0')}${'f'.repeat(190)}.md`);
      for (let i = 0; i < names.length; i += 500) {
        await Promise.all(names.slice(i, i + 500).map(name => writeFile(path.join(dir, name), '')));
      }
      const files = (await buildQuickOpenCacheForRoot(root)).filter(item => item.type === 'file');
      expect(files).toHaveLength(names.length);
      expect(files.reduce((bytes, item) => bytes + item.path.length + 1, 0)).toBeGreaterThan(OLD_BUFFER_CAP);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('still indexes the rest of the root when ripgrep cannot read one directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'nimbalyst-quickopen-unreadable-'));
    const locked = path.join(root, 'locked');
    try {
      await mkdir(locked);
      await writeFile(path.join(locked, 'hidden.md'), '');
      await writeFile(path.join(root, 'visible.md'), '');
      fs.chmodSync(locked, 0o000);
      const files = relativeTo(root, await findWorkspaceFiles(root));
      expect(files).toContain('visible.md');
    } finally {
      fs.chmodSync(locked, 0o755);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns complete matches for the first 50 files when ripgrep --json output passes 5MB', async () => {
    const contentRoot = await mkdtemp(path.join(os.tmpdir(), 'nimbalyst-content-large-'));
    try {
      const body = Array.from({ length: 1000 }, (_, i) => `needle ${i} ${'x'.repeat(80)}`).join('\n');
      await Promise.all(Array.from({ length: 60 }, (_, i) => writeFile(path.join(contentRoot, `file-${i}.md`), body)));
      const results = await searchFileContent([contentRoot], 'NEEDLE');
      expect(results).toHaveLength(50);
      expect(results.every(result => result.matches.length === 1000)).toBe(true);

      await writeFile(path.join(contentRoot, 'code.ts'), 'needle\n');
      const markdownOnly = await searchFileContent([contentRoot], 'NEEDLE', { typeArgs: ['--type', 'md'], maxFiles: 100 });
      expect(markdownOnly).toHaveLength(60);
      expect(markdownOnly.every(result => result.path.endsWith('.md'))).toBe(true);
    } finally {
      await rm(contentRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
