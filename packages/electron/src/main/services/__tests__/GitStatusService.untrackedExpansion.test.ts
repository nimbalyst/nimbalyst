/**
 * Tests for how `GitStatusService` re-expands the untracked directories that
 * `git status --porcelain` collapses into a single `?? dir/` entry.
 *
 * Two regressions are covered:
 *
 * - NIM-1782: "Commit with AI" on a worktree enumerated gitignored files
 *   (node_modules) and blew the commit prompt up to 90k files. The expansion
 *   must let GIT decide what a directory contains, so `.gitignore` rules and
 *   nested-repository boundaries are honored. Never a filesystem walk.
 * - NIM-2286: each collapsed directory cost its own SYNCHRONOUS `git ls-files`
 *   child process, so N untracked directories blocked the Electron main thread
 *   on N subprocesses. All three status APIs now share one async batched call.
 *
 * Builds a REAL git repo on disk (the code shells out to `git`) and counts the
 * actual child processes at the `child_process.execFile` boundary, so the
 * batching assertions cannot be satisfied by a mock this test injected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GitStatusService } from '../GitStatusService';
import { getUntrackedFilesInDirectories } from '../../utils/gitUtils';
import { assertGitSandbox, gitSandboxEnv } from '../testSupport/gitTestSandbox';

// Records every git subprocess our code launches through `child_process.execFile`,
// then delegates to the real implementation so git actually runs -- the batching
// assertions below count real child processes, not calls into a mock this test
// injected. The `util.promisify.custom` handler keeps promisified callers
// resolving `{ stdout, stderr }` rather than a bare string.
const { execFileCalls } = vi.hoisted(() => ({ execFileCalls: [] as string[][] }));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  const { promisify } = await vi.importActual<typeof import('util')>('util');

  const record = (args: unknown) => {
    execFileCalls.push(Array.isArray(args) ? (args as string[]) : []);
  };

  const execFileSpy = (...callArgs: any[]) => {
    record(callArgs[1]);
    return (actual.execFile as any)(...callArgs);
  };
  (execFileSpy as any)[promisify.custom] = (file: string, args: string[], options: unknown) =>
    new Promise((resolve, reject) => {
      record(args);
      (actual.execFile as any)(file, args, options, (error: Error | null, stdout: string, stderr: string) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    });

  return { ...actual, execFile: execFileSpy };
});

/** git invocations recorded so far whose subcommand is `name`. */
function gitCalls(name: string): string[][] {
  return execFileCalls.filter((args) => args.includes(name));
}

let repo: string;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: gitSandboxEnv() });
}

/** Number of collapsed `?? dir/` entries the fixture produces. */
const UNTRACKED_DIR_COUNT = 12;

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'nim-untracked-expand-'));
  git(['init'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  // A hook-inherited GIT_DIR would otherwise redirect the commit below onto the
  // developer's live branch. See testSupport/gitTestSandbox.ts.
  assertGitSandbox(repo);

  // Ignore node_modules, like every real repo.
  await fs.writeFile(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
  git(['add', '.gitignore'], repo);
  git(['commit', '-m', 'init'], repo);

  // Many brand-new untracked directories. `git status --porcelain` reports each
  // as a SINGLE entry (`?? newpkg-000/`), so each one needs re-expanding --
  // which is what used to cost one blocking subprocess apiece.
  for (let i = 0; i < UNTRACKED_DIR_COUNT; i++) {
    const pkg = path.join(repo, `newpkg-${String(i).padStart(3, '0')}`);
    await fs.mkdir(path.join(pkg, 'src'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'src', 'index.ts'), `export const a = ${i};\n`);
    await fs.writeFile(path.join(pkg, 'package.json'), `{"name":"newpkg-${i}"}\n`);
  }

  // A filename containing spaces: the expansion parses NUL-separated (`-z`)
  // output end to end, so it must survive.
  await fs.writeFile(path.join(repo, 'newpkg-000', 'src', 'with spaces.ts'), 'export {};\n');

  // An installed node_modules inside an untracked dir -- gitignored, and the
  // source of the 90k-file blowup when expanded with a gitignore-blind walk.
  const dep = path.join(repo, 'newpkg-000', 'node_modules', 'left-pad');
  await fs.mkdir(dep, { recursive: true });
  await fs.writeFile(path.join(dep, 'index.js'), 'module.exports = () => {};\n');
  await fs.writeFile(path.join(dep, 'package.json'), '{"name":"left-pad"}\n');

  // A gitignored build output inside a different untracked dir.
  await fs.mkdir(path.join(repo, 'newpkg-001', 'dist'), { recursive: true });
  await fs.writeFile(path.join(repo, 'newpkg-001', 'dist', 'bundle.js'), 'ignored\n');

  // A nested repository. Git stops at the boundary, so the nested repo's own
  // untracked file belongs to IT, not to the outer expansion.
  const nested = path.join(repo, 'nested-repo');
  await fs.mkdir(nested);
  git(['init'], nested);
  git(['config', 'user.email', 'test@example.com'], nested);
  git(['config', 'user.name', 'Test'], nested);
  git(['config', 'commit.gpgsign', 'false'], nested);
  await fs.writeFile(path.join(nested, 'tracked.ts'), 'export const tracked = true;\n');
  git(['add', 'tracked.ts'], nested);
  git(['commit', '-m', 'nested init'], nested);
  await fs.writeFile(path.join(nested, 'nested-change.ts'), 'export const nested = true;\n');

  execFileCalls.length = 0;
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

/** Repo-relative, forward-slashed keys of a GitStatusResult. */
function relKeys(statuses: Record<string, unknown>): string[] {
  return Object.keys(statuses)
    .map((p) => path.relative(repo, p).split(path.sep).join('/'))
    .sort();
}

describe('GitStatusService untracked-directory expansion', () => {
  it('expands untracked dirs to git-visible files only, excluding gitignored node_modules (NIM-1782)', async () => {
    const service = new GitStatusService();
    const rel = relKeys(await service.getAllFileStatuses(repo));

    // The git-visible untracked files inside the directory ARE included.
    expect(rel).toContain('newpkg-000/src/index.ts');
    expect(rel).toContain('newpkg-000/package.json');

    // A filename with spaces survives NUL-separated parsing.
    expect(rel).toContain('newpkg-000/src/with spaces.ts');

    // Gitignored files inside the untracked directories are NOT included.
    expect(rel.filter((p) => p.includes('node_modules') || p.includes('/dist/'))).toEqual([]);

    // Git, not a filesystem walk, owns the nested-repository boundary: the
    // nested repo's untracked file is not part of the outer repo's expansion.
    expect(rel).not.toContain('nested-repo/nested-change.ts');

    // Sanity: the whole set is small (the real bug produced ~90k entries).
    expect(rel.length).toBeLessThan(40);
  });

  it('issues ONE batched ls-files for all collapsed directories (NIM-2286)', async () => {
    const service = new GitStatusService();
    await service.getAllFileStatuses(repo);

    // One status, one expansion -- not one expansion per untracked directory.
    expect(gitCalls('status')).toHaveLength(1);
    expect(gitCalls('ls-files')).toHaveLength(1);

    // The single call carried every collapsed directory as a pathspec.
    const pathspecs = gitCalls('ls-files')[0].slice(gitCalls('ls-files')[0].indexOf('--') + 1);
    expect(pathspecs).toHaveLength(UNTRACKED_DIR_COUNT + 1); // + nested-repo
    expect(pathspecs).toContain('newpkg-000');
    expect(pathspecs).toContain(`newpkg-${String(UNTRACKED_DIR_COUNT - 1).padStart(3, '0')}`);
  });

  it('passes --no-optional-locks so read-only calls never lock .git/index (NIM-2285)', async () => {
    const service = new GitStatusService();
    await service.getAllFileStatuses(repo);

    expect(gitCalls('status')[0]).toEqual(['--no-optional-locks', 'status', '--porcelain']);
    expect(gitCalls('ls-files')[0].slice(0, 5)).toEqual([
      '--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z',
    ]);
  });

  it('shares one expansion across concurrent status APIs', async () => {
    const service = new GitStatusService();
    const [statuses, uncommitted] = await Promise.all([
      service.getAllFileStatuses(repo),
      service.getUncommittedFiles(repo),
    ]);

    expect(gitCalls('status')).toHaveLength(1);
    expect(gitCalls('ls-files')).toHaveLength(1);

    // Both callers still get complete, independently-shaped results.
    expect(relKeys(statuses)).toContain('newpkg-005/src/index.ts');
    expect(uncommitted.map((p) => path.relative(repo, p).split(path.sep).join('/')))
      .toContain('newpkg-005/src/index.ts');
  });

  it('reports a file inside a collapsed untracked directory as untracked, but not a gitignored one', async () => {
    const service = new GitStatusService();
    const statuses = await service.getFileStatus(repo, [
      'newpkg-000/src/with spaces.ts',
      'newpkg-000/node_modules/left-pad/index.js',
      path.join('nested-repo', 'nested-change.ts'),
    ]);

    // Hidden by the collapsed `?? newpkg-000/` entry, but git lists it.
    expect(statuses['newpkg-000/src/with spaces.ts']).toMatchObject({ status: 'untracked' });

    // Gitignored, so it must NOT be surfaced as an untracked change -- this is
    // the file class that blew up the commit prompt in NIM-1782.
    expect(statuses['newpkg-000/node_modules/left-pad/index.js'])
      .toMatchObject({ status: 'unchanged' });

    // The nested repo owns its own file, and reports it directly.
    expect(statuses[path.join('nested-repo', 'nested-change.ts')])
      .toMatchObject({ status: 'untracked' });

    // Still one expansion, for the one directory that actually needed it.
    expect(gitCalls('ls-files')).toHaveLength(1);
  });

  it('splits a pathological directory count across argv-sized chunks', async () => {
    // Pathspecs travel as argv, which the OS caps. Enough directories to exceed
    // the per-call limit must still expand -- in more than one call -- instead
    // of failing the whole batch with E2BIG. The extra directories need not
    // exist: `git ls-files` ignores pathspecs that match nothing.
    const dirs = [
      path.join(repo, 'newpkg-000'),
      ...Array.from({ length: 600 }, (_, i) => path.join(repo, `absent-${i}`)),
    ];

    const expansions = await getUntrackedFilesInDirectories(repo, dirs);

    expect(gitCalls('ls-files').length).toBeGreaterThan(1);
    expect(expansions.get(path.join(repo, 'newpkg-000'))).toContain('newpkg-000/src/with spaces.ts');
  });

  it('does not populate the cache from an expansion invalidated mid-flight', async () => {
    const service = new GitStatusService();

    // clearCache lands while the status/expansion subprocesses are still in
    // flight. The in-flight result must still be returned to its caller, but
    // must not be written into the cache it was invalidated out of.
    const stale = service.getAllFileStatuses(repo);
    service.clearCache(repo);
    expect(relKeys(await stale)).toContain('newpkg-000/src/index.ts');

    const callsBefore = gitCalls('ls-files').length;
    expect(relKeys(await service.getAllFileStatuses(repo))).toContain('newpkg-000/src/index.ts');
    // A cached (invalidated) result would have skipped git entirely.
    expect(gitCalls('ls-files').length).toBeGreaterThan(callsBefore);
  });
});
