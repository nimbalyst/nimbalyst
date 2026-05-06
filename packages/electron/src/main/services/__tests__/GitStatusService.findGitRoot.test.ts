/**
 * Tests for `findGitRootForFile` - the helper that backs the nested-repo
 * fix in `GitStatusService` (#122). Builds real on-disk directory trees
 * under a tmp dir with `.git` markers and asserts the walker returns the
 * correct owning root.
 *
 * Uses real filesystem rather than mocks because the helper relies on
 * `existsSync` and on path semantics that differ subtly between mocked
 * and real `path` modules across platforms.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { findGitRootForFile } from '../GitStatusService';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-git-root-test-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function mkdirp(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function touchFile(p: string): Promise<void> {
  await mkdirp(path.dirname(p));
  await fs.writeFile(p, '');
}

async function makeGitRepo(p: string): Promise<void> {
  await mkdirp(path.join(p, '.git'));
  // Drop a HEAD file so existsSync(.git) is unambiguous on Windows.
  await fs.writeFile(path.join(p, '.git', 'HEAD'), 'ref: refs/heads/main\n');
}

describe('findGitRootForFile', () => {
  it('returns workspace root when workspace IS a git repo', async () => {
    const workspace = path.join(tmpRoot, 'ws');
    await makeGitRepo(workspace);
    const file = path.join(workspace, 'src', 'app.ts');
    await touchFile(file);

    const root = findGitRootForFile(file, workspace);
    expect(root).toBe(path.resolve(workspace));
  });

  it('returns the nested repo root when workspace root has no .git but a subdir does', async () => {
    // The reproduce scenario from #122: superproject layout with a non-git
    // root containing one or more nested repos.
    const workspace = path.join(tmpRoot, 'super');
    await mkdirp(workspace);
    const nested = path.join(workspace, 'project-a');
    await makeGitRepo(nested);
    const file = path.join(nested, 'src', 'main.ts');
    await touchFile(file);

    const root = findGitRootForFile(file, workspace);
    expect(root).toBe(path.resolve(nested));
  });

  it('returns the deepest nested repo when both workspace and inner subdir are git repos', async () => {
    // Nested repos inside a git workspace (submodule-like) should resolve
    // to the inner repo so its files are queried with the right cwd.
    const workspace = path.join(tmpRoot, 'monorepo');
    await makeGitRepo(workspace);
    const sub = path.join(workspace, 'vendor', 'thirdparty');
    await makeGitRepo(sub);
    const file = path.join(sub, 'lib.ts');
    await touchFile(file);

    const root = findGitRootForFile(file, workspace);
    expect(root).toBe(path.resolve(sub));
  });

  it('returns null when workspace contains no git repos at all', async () => {
    const workspace = path.join(tmpRoot, 'nogit');
    await mkdirp(workspace);
    const file = path.join(workspace, 'notes.md');
    await touchFile(file);

    expect(findGitRootForFile(file, workspace)).toBeNull();
  });

  it('returns null when file is outside the workspace boundary', async () => {
    // Even if there is a .git somewhere up the tree, we must not match
    // against a repo outside the configured workspace - that would route
    // git queries to an unrelated repo.
    const workspace = path.join(tmpRoot, 'ws');
    await makeGitRepo(workspace);
    const sibling = path.join(tmpRoot, 'other', 'file.txt');
    await touchFile(sibling);

    expect(findGitRootForFile(sibling, workspace)).toBeNull();
  });

  it('handles relative file paths by resolving against the workspace', async () => {
    const workspace = path.join(tmpRoot, 'ws');
    await makeGitRepo(workspace);
    const file = path.join(workspace, 'a', 'b.ts');
    await touchFile(file);

    // Pass path relative to workspace.
    const root = findGitRootForFile('a/b.ts', workspace);
    expect(root).toBe(path.resolve(workspace));
  });

  it('does not match a sibling directory whose path is a string-prefix of the workspace', async () => {
    // /tmp/.../foo and /tmp/.../foo2 share a prefix but are unrelated.
    // The walker must use proper path-segment boundaries, not raw
    // string-prefix matches.
    const ws = path.join(tmpRoot, 'foo');
    await makeGitRepo(ws);
    const evilTwin = path.join(tmpRoot, 'foo2', 'inside.ts');
    await touchFile(evilTwin);

    expect(findGitRootForFile(evilTwin, ws)).toBeNull();
  });
});
