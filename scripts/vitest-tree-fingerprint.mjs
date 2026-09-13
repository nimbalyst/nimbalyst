/**
 * Fingerprints the working tree so a recorded test run can prove whether it
 * still describes the current code.
 *
 * `.vitest/last-run.log` already holds the last run's failures, but a reader
 * cannot tell whether those failures are still the truth -- the log says when
 * it finished, not what it ran against. Faced with "I edited three files since
 * then, maybe", an agent re-runs a multi-minute suite to learn something it
 * already had. That uncertainty is the entire cost.
 *
 * A fingerprint removes it: HEAD plus the content hash of every dirty path.
 * Same digest means the log is not stale evidence, it IS the current state.
 *
 * It also makes the log safe under parallel sessions sharing one checkout. A
 * sibling session's run clobbers `.vitest/`, and today you cannot tell. With a
 * fingerprint, a run against a different tree reads as STALE -- and a run
 * against an identical tree is valid for you regardless of who produced it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

/**
 * Paths that cannot change a test outcome. Without these, the reporter's own
 * output would dirty the tree it just fingerprinted and every run would read
 * back as STALE.
 */
const IGNORED_DIRS = [
  '.vitest',
  '.wrangler',
  '.vitest-mf',
  'coverage',
  'node_modules',
  'nimbalyst-local',
];

/**
 * Matched at ANY depth, not just the repository root. `git status` reports
 * paths relative to the top level, so in a monorepo the run log lands at
 * `packages/<pkg>/.vitest/` -- a root-anchored prefix misses it and the
 * reporter's own output dirties the tree it just fingerprinted, making every
 * run read back as STALE.
 */
/**
 * Root-level archives of the local-only directory (`nimbalyst-local.zip`). They
 * are untracked, never test inputs, and can run to hundreds of megabytes; every
 * fingerprint reads each dirty path in full, twice per push.
 */
const LOCAL_ARCHIVE = /^nimbalyst-local\.[\w.]+$/;

const isIgnored = (repoPath) =>
  LOCAL_ARCHIVE.test(repoPath) ||
  IGNORED_DIRS.some(
    (dir) =>
      repoPath === dir || repoPath.startsWith(`${dir}/`) || repoPath.includes(`/${dir}/`),
  );

// `env` is threaded through rather than inherited implicitly so tests can point
// git at a scratch repo. Inside a git hook, GIT_DIR / GIT_INDEX_FILE override
// `cwd` entirely -- harmless for the read-only commands here, fatal for a test
// that means to operate on a sandbox.
const git = (args, cwd, env) =>
  execFileSync('git', args, {
    cwd,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Parse `git status --porcelain -z -uall` into `{ status, path }` records.
 *
 * NUL-delimited rather than newline-delimited because a path may legally
 * contain a newline; the `-z` form also skips the quoting/escaping that plain
 * `--porcelain` applies to unusual bytes.
 *
 * Renames (`R`) and copies (`C`) emit two NUL-terminated fields -- new path
 * then old path -- so the entry cursor has to step twice for those.
 */
function parsePorcelain(raw) {
  const entries = [];
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const status = field.slice(0, 2);
    const repoPath = field.slice(3);
    entries.push({ status, path: repoPath });
    // A rename/copy consumes the following field as its source path.
    if (status[0] === 'R' || status[0] === 'C') i++;
  }
  return entries;
}

/**
 * Compute a fingerprint of the git repository containing `cwd`.
 *
 * Returns `null` when there is no usable git repository -- callers treat that
 * as "cannot prove freshness", never as "unchanged".
 */
/**
 * Additional checkouts whose contents this suite actually tests, as a
 * colon-separated list of paths. Set by the package whose tests reach across
 * a repository boundary; empty everywhere else.
 */
export const extraRootsFromEnv = (env = process.env) =>
  (env.NIM_FINGERPRINT_EXTRA_REPOS ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);

export function computeTreeFingerprint(
  cwd = process.cwd(),
  env = process.env,
  extraRoots = extraRootsFromEnv(env),
  toolchain = { nodeMajor: process.versions.node.split(".")[0], platform: process.platform, arch: process.arch },
) {
  let root;
  let head;
  try {
    root = git(['rev-parse', '--show-toplevel'], cwd, env);
    // A repository with no commits yet has no HEAD; the dirty-file hashes below
    // still fingerprint it perfectly well.
    try {
      head = git(['rev-parse', 'HEAD'], cwd, env);
    } catch {
      head = 'no-commit';
    }
  } catch {
    return null;
  }

  const raw = execFileSync('git', ['status', '--porcelain', '-z', '-uall'], {
    cwd: root,
    env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });

  const files = [];
  for (const entry of parsePorcelain(raw)) {
    if (isIgnored(entry.path)) continue;
    let hash;
    try {
      hash = sha256(fs.readFileSync(path.join(root, entry.path)));
    } catch {
      // Deleted, or a directory we cannot read. The status code alone still
      // distinguishes this tree from one where the path is present.
      hash = 'absent';
    }
    files.push({ path: entry.path, status: entry.status, hash });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Some suites test source that lives in a SIBLING checkout -- collabv3's
  // integration tests alias `../../runtime/...` into stravu-editor. Without
  // those roots folded in, editing the code under test leaves the digest
  // untouched and the run reads back as CURRENT when it is anything but.
  const extras = [];
  for (const extraRoot of extraRoots) {
    const extra = computeTreeFingerprint(extraRoot, env, [], toolchain);
    if (!extra) return null;
    extras.push({ root: extra.root, digest: extra.digest, files: extra.files });
  }

  const digest = sha256(
    [
      head,
      JSON.stringify(toolchain),
      ...files.map((f) => `${f.status} ${f.hash} ${f.path}`),
      ...extras.map((e) => `extra ${e.root} ${e.digest}`),
    ].join('\n'),
  ).slice(0, 16);

  return { root, head, files, extras, toolchain, digest };
}

/**
 * Compare a recorded fingerprint against the tree as it is now.
 *
 * `verdict` is one of:
 *  - `current` -- the recorded run describes this exact tree. Do not re-run.
 *  - `stale`   -- something the run covered has changed since. `changed` says what.
 *  - `unknown` -- no recorded fingerprint, or git is unavailable. Cannot prove
 *                 anything; treat the recorded run as untrustworthy.
 */
export function compareTreeFingerprint(recorded, cwd = process.cwd(), env = process.env) {
  // Recompute against the roots the RUN used, taken from the record itself.
  // Reading them from the environment instead would make the verdict depend on
  // how the reader was launched -- `test:last` is a plain node process and does
  // not inherit whatever the vitest config set, so every collabv3 run would
  // read STALE and the log would be worthless in the one repo it was built for.
  const now = recorded
    ? computeTreeFingerprint(
        cwd,
        env,
        (recorded.extras ?? []).map((e) => e.root),
      )
    : null;
  if (!recorded || !recorded.digest || !now) {
    return { verdict: 'unknown', now, changed: [] };
  }
  if (recorded.digest === now.digest) {
    return { verdict: 'current', now, changed: [] };
  }

  const before = new Map((recorded.files ?? []).map((f) => [f.path, f]));
  const after = new Map(now.files.map((f) => [f.path, f]));
  const changed = [];

  for (const [repoPath, file] of after) {
    const prior = before.get(repoPath);
    if (!prior) changed.push({ path: repoPath, change: 'touched since run' });
    else if (prior.hash !== file.hash || prior.status !== file.status) {
      changed.push({ path: repoPath, change: 'modified since run' });
    }
  }
  for (const repoPath of before.keys()) {
    if (!after.has(repoPath)) changed.push({ path: repoPath, change: 'reverted since run' });
  }

  const recordedExtras = new Map((recorded.extras ?? []).map((e) => [e.root, e.digest]));
  for (const extra of now.extras ?? []) {
    if (recordedExtras.get(extra.root) !== extra.digest) {
      changed.push({ path: extra.root, change: 'sibling checkout changed since run' });
    }
  }

  if (JSON.stringify(recorded.toolchain) !== JSON.stringify(now.toolchain)) {
    changed.push({ path: 'Node/platform/architecture', change: 'toolchain changed since run' });
  }

  if (changed.length === 0 && recorded.head !== now.head) {
    changed.push({ path: `HEAD ${recorded.head} -> ${now.head}`, change: 'checkout moved' });
  }

  changed.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { verdict: 'stale', now, changed };
}
