/**
 * Make a checkout directory match the head of its mapped branch.
 *
 * Every git invocation passes an argv ARRAY -- never a command string, never a
 * shell. That closes shell injection but NOT argument injection: git parses its
 * own argv, so a branch named `--upload-pack=/bin/sh` is read as an option and
 * executes, shell or no shell. The values come from a JSON file that a remote
 * request causes us to re-read, so all three are validated against an allowlist
 * before they reach argv, and `--end-of-options` terminates option parsing
 * wherever git accepts it (verified against git 2.50 for `clone` and `fetch`;
 * `checkout` is deliberately excluded, where `--` means pathspec and would
 * change the command's meaning).
 *
 * `checkoutDir` is confined to a root because it is a destructive target: the
 * update path resets a tree, and a mapping pointing at `/` or at the node's own
 * config directory would do it there. Containment is checked on the REAL path,
 * so a symlink out of the root is caught rather than followed.
 *
 * `git` is also spawned through an explicit promise wrapping the callback form
 * rather than `promisify(execFile)`: `promisify` follows `util.promisify.custom`
 * and bypasses a test's `execFile` spy entirely, so the mock records zero calls
 * and the subprocess silently runs for real.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { WorkspaceMapping } from './workspaces.js';

/** Runs `git <args>` in `cwd`. Rejects with git's stderr on a non-zero exit. */
export type GitRunner = (args: string[], cwd?: string) => Promise<void>;

export type CheckoutOutcome = 'cloned' | 'updated';

/** Every checkout lands under here unless the config names another root. */
export const DEFAULT_CHECKOUT_ROOT = '/workspace';

export interface CheckoutDeps {
  runGit?: GitRunner;
  exists?: (targetPath: string) => boolean;
  makeDirectory?: (targetPath: string) => void;
  /** Resolves symlinks for containment. Returns the input when the path is absent. */
  realPath?: (targetPath: string) => string;
  /** Absolute path every `checkoutDir` must live under. */
  checkoutRoot?: string;
}

function fail(message: string): never {
  throw new Error(`[nimbalyst-node] ${message}`);
}

/**
 * git's own ref-name rules, tightened.
 *
 * Deliberately an allowlist. The rejection that matters most is a leading `-`,
 * which turns a positional into an option (`--upload-pack=` is remote code
 * execution on the client), but `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\` and
 * control characters are all refused too -- they are either invalid refs or
 * revision syntax, and none of them belong in a branch a desktop configured.
 */
export function validateBranch(branch: string): string {
  const invalid = (why: string): never =>
    fail(`invalid branch "${branch}" in the workspaces file: ${why}`);

  if (branch.length === 0) invalid('empty');
  // The one that is a vulnerability rather than a typo.
  if (branch.startsWith('-')) invalid('starts with "-", which git parses as an option');
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch)) invalid('contains characters outside [A-Za-z0-9._/-]');
  if (branch.includes('..')) invalid('contains ".."');
  if (branch.startsWith('/') || branch.endsWith('/')) invalid('starts or ends with "/"');
  if (branch.includes('//')) invalid('contains an empty path component');
  if (branch.startsWith('.') || branch.endsWith('.')) invalid('starts or ends with "."');
  if (branch.endsWith('.lock')) invalid('ends with ".lock"');
  return branch;
}

/**
 * https only, with a real hostname.
 *
 * `file://`, `ssh://` and git's scp-like `host:path` form are all refused: a
 * headless node clones what the desktop mapped over the network, and the other
 * transports either reach the container's own filesystem or pull in an ssh
 * client whose configuration this process does not control.
 */
export function validateRepoUrl(repoUrl: string): string {
  const invalid = (why: string): never =>
    fail(`invalid repoUrl "${repoUrl}" in the workspaces file: ${why}`);

  if (repoUrl.startsWith('-')) invalid('starts with "-", which git parses as an option');

  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return invalid('not a URL');
  }
  if (parsed.protocol !== 'https:') invalid(`protocol "${parsed.protocol}" is not https:`);
  if (!parsed.hostname) invalid('has no hostname');
  return repoUrl;
}

/**
 * Confine the checkout to `root`, following symlinks first.
 *
 * The realpath is taken of the nearest EXISTING ancestor, because the checkout
 * directory itself usually does not exist yet on the clone path -- but the
 * directory we are about to create it in does, and that is where a symlink
 * pointing out of the root would be.
 */
export function validateCheckoutDir(
  checkoutDir: string,
  root: string,
  realPath: (targetPath: string) => string,
): string {
  const invalid = (why: string): never =>
    fail(`invalid checkoutDir "${checkoutDir}" in the workspaces file: ${why}`);

  if (!path.isAbsolute(checkoutDir)) invalid('is not absolute');

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(checkoutDir);
  if (resolved === resolvedRoot) invalid(`is the checkout root ${resolvedRoot} itself`);

  const contains = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
  };

  if (!contains(resolvedRoot, resolved)) {
    invalid(`is outside the checkout root ${resolvedRoot}`);
  }

  // Now the same question about where those paths actually point. Only the
  // part of the chain at or below the root can carry a symlink that escapes it,
  // so the walk stops there -- climbing past it just means the root does not
  // exist yet, which is not a traversal.
  let existingAncestor = resolved;
  while (
    !existsSync(existingAncestor)
    && (existingAncestor === resolvedRoot || contains(resolvedRoot, existingAncestor))
  ) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }

  if (existsSync(existingAncestor) && existsSync(resolvedRoot)) {
    const realRoot = realPath(resolvedRoot);
    const realAncestor = realPath(existingAncestor);
    if (realAncestor !== realRoot && !contains(realRoot, realAncestor)) {
      invalid(`resolves through a symlink to ${realAncestor}, outside ${realRoot}`);
    }
  }

  return resolved;
}

/**
 * The canonical, confined checkout directory for a mapping.
 *
 * Separate from `ensureCheckout` because confinement is needed on EVERY path
 * that turns a mapping into a working directory, not just the one that runs
 * git. A queued follow-up turn does no git at all -- it reuses the tree the
 * previous turn left -- and it was taking `mapping.checkoutDir` verbatim, so a
 * workspaces file edited between the clone and the follow-up could point the
 * agent's cwd anywhere. The mapping is re-read from disk on every request, so
 * "it was validated once" is not a property this code has.
 */
export function confineCheckout(mapping: WorkspaceMapping, deps: CheckoutDeps = {}): string {
  return validateCheckoutDir(
    mapping.checkoutDir,
    deps.checkoutRoot ?? DEFAULT_CHECKOUT_ROOT,
    deps.realPath ?? defaultRealPath,
  );
}

export const runGitCommand: GitRunner = (args, cwd) =>
  new Promise<void>((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        // git's own stderr is the only useful diagnostic; the Error message is
        // just "Command failed".
        const detail = String(stderr || error.message).trim();
        reject(new Error(`git ${args[0]} failed: ${detail}`));
        return;
      }
      resolve();
    });
  });

function defaultRealPath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return targetPath;
  }
}

/**
 * Clone on first sight, otherwise fast-forward the existing tree to the branch
 * head.
 *
 * The update path is `fetch` + `checkout -B <branch> FETCH_HEAD` rather than
 * `pull`: a shallow clone with local commits (an agent turn that committed) has
 * no merge base, and a `pull` there fails or produces a merge nobody asked for.
 * Resetting the branch pointer to the fetched head is the behaviour a fresh
 * container would have had.
 */
export async function ensureCheckout(
  mapping: WorkspaceMapping,
  deps: CheckoutDeps = {},
): Promise<CheckoutOutcome> {
  const runGit = deps.runGit ?? runGitCommand;
  const exists = deps.exists ?? existsSync;
  const makeDirectory = deps.makeDirectory
    ?? ((target: string) => { mkdirSync(target, { recursive: true }); });

  // Validate BEFORE anything touches the filesystem or spawns git.
  const branch = validateBranch(mapping.branch);
  const repoUrl = validateRepoUrl(mapping.repoUrl);
  const checkoutDir = confineCheckout(mapping, deps);

  if (!exists(checkoutDir)) {
    makeDirectory(path.dirname(checkoutDir));
    await runGit([
      'clone',
      '--depth', '1',
      '--branch', branch,
      '--end-of-options',
      repoUrl,
      checkoutDir,
    ]);
    return 'cloned';
  }

  await runGit(['fetch', '--depth', '1', '--end-of-options', 'origin', branch], checkoutDir);
  // No `--end-of-options` here: in `checkout` that region is a PATHSPEC, so
  // adding it changes what the command means. `branch` is allowlisted above and
  // `FETCH_HEAD` is a literal.
  await runGit(['checkout', '-B', branch, 'FETCH_HEAD'], checkoutDir);
  return 'updated';
}
