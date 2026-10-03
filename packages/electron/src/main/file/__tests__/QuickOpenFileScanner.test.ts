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
import * as os from 'os';
import * as path from 'path';
import { rgPath } from '@vscode/ripgrep';
import { assertGitSandbox, FIXTURE_IDENTITY_ARGS, gitSandboxEnv } from '../../services/testSupport/gitTestSandbox';

vi.mock('../../services/ripgrepPath', () => ({ getRipgrepPath: () => rgPath }));

import { findWorkspaceFiles, listContentSearchRoots } from '../QuickOpenFileScanner';

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

  it('names each nested clone once for content search, even when it is also a root', async () => {
    const roots = await listContentSearchRoots([outer, inner]);

    expect(roots).toEqual([outer, inner, path.join(outer, 'mirror')]);
  });
});
