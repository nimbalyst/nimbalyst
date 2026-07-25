/**
 * Regression test for NIM-1782: "Commit with AI" on a worktree enumerated
 * gitignored files (node_modules) and blew the commit prompt up to 90k files.
 *
 * `git status --porcelain` collapses an untracked directory into a single
 * `?? dir/` entry. `GitStatusService` re-expands those directories so the
 * edited-files UI can list individual files -- but the expansion must respect
 * `.gitignore`, or an untracked dir that contains an installed `node_modules`
 * explodes into tens of thousands of ignored paths.
 *
 * Builds a REAL git repo on disk (the code shells out to `git`), drops an
 * untracked directory containing both a tracked-eligible file and a gitignored
 * `node_modules`, and asserts the expansion returns only git-visible files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GitStatusService } from '../GitStatusService';

let repo: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-untracked-expand-'));
  git(['init'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);

  // Ignore node_modules, like every real repo.
  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  git(['add', '.gitignore'], repo);
  git(['commit', '-m', 'init'], repo);

  // A brand-new untracked directory. `git status --porcelain` reports this as a
  // SINGLE entry: `?? newpkg/`.
  const pkg = path.join(repo, 'newpkg');
  await fs.mkdir(path.join(pkg, 'src'), { recursive: true });
  await fs.writeFile(path.join(pkg, 'src', 'index.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(pkg, 'package.json'), '{"name":"newpkg"}\n');

  // An installed node_modules inside that untracked dir -- gitignored, and the
  // source of the 90k-file blowup when expanded with a gitignore-blind walk.
  const dep = path.join(pkg, 'node_modules', 'left-pad');
  await fs.mkdir(dep, { recursive: true });
  await fs.writeFile(path.join(dep, 'index.js'), 'module.exports = () => {};\n');
  await fs.writeFile(path.join(dep, 'package.json'), '{"name":"left-pad"}\n');
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('GitStatusService untracked-directory expansion (NIM-1782)', () => {
  it('expands untracked dirs to git-visible files only, excluding gitignored node_modules', async () => {
    const service = new GitStatusService();
    const statuses = await service.getAllFileStatuses(repo);

    const rel = Object.keys(statuses)
      .map((p) => path.relative(repo, p).split(path.sep).join('/'))
      .sort();

    // The git-visible untracked files inside the directory ARE included.
    expect(rel).toContain('newpkg/src/index.ts');
    expect(rel).toContain('newpkg/package.json');

    // Gitignored files inside the untracked directory are NOT included.
    const ignored = rel.filter((p) => p.includes('node_modules') || p.includes('/dist/'));
    expect(ignored).toEqual([]);

    // Sanity: the whole set is small (the real bug produced ~90k entries).
    expect(rel.length).toBeLessThan(20);
  });
});
