import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveGitContext } from '../GitContextService';

const execFileAsync = promisify(execFile);

let tmpRoot: string;

beforeEach(async () => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-git-context-'));
  // git rev-parse returns physical paths; normalize the fixture the same way
  tmpRoot = await fs.realpath(raw);
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function initRepo(dir: string): Promise<void> {
  await git(['init', '-q'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await git(['config', 'user.name', 'Test User'], dir);
}

describe('resolveGitContext', () => {
  it('resolves the repo root from a subfolder workspace', async () => {
    await initRepo(tmpRoot);
    const sub = path.join(tmpRoot, 'home');
    await fs.mkdir(sub, { recursive: true });

    expect(resolveGitContext(sub)).toEqual({ isRepo: true, gitRoot: tmpRoot });
  });

  it('returns the workspace itself when it is the repo root', async () => {
    await initRepo(tmpRoot);

    expect(resolveGitContext(tmpRoot)).toEqual({ isRepo: true, gitRoot: tmpRoot });
  });

  it('reports non-repos as not a repo', async () => {
    expect(resolveGitContext(tmpRoot)).toEqual({ isRepo: false, gitRoot: null });
  });

  it('reports empty workspacePath as not a repo without spawning git', () => {
    expect(resolveGitContext('')).toEqual({ isRepo: false, gitRoot: null });
  });

  it('picks up git init on the very next call (no caching)', async () => {
    expect(resolveGitContext(tmpRoot).isRepo).toBe(false);
    await initRepo(tmpRoot);
    expect(resolveGitContext(tmpRoot)).toEqual({ isRepo: true, gitRoot: tmpRoot });
  });

  it('returns the worktree root inside a linked worktree', async () => {
    await initRepo(tmpRoot);
    await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'a\n');
    await git(['add', '.'], tmpRoot);
    await git(['commit', '-q', '-m', 'init'], tmpRoot);
    const wtPath = path.join(tmpRoot, '..', path.basename(tmpRoot) + '-wt');
    await git(['worktree', 'add', '-q', wtPath, '-b', 'wt-branch'], tmpRoot);
    try {
      const realWt = await fs.realpath(wtPath);
      const sub = path.join(realWt, 'nested');
      await fs.mkdir(sub, { recursive: true });
      expect(resolveGitContext(sub)).toEqual({ isRepo: true, gitRoot: realWt });
    } finally {
      await fs.rm(wtPath, { recursive: true, force: true });
    }
  });
});
