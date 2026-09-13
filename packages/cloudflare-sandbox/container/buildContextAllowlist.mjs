/**
 * What may enter the container build context, stated as data.
 *
 * The build context is NOT the checkout. This repository holds a developer's
 * live working tree: `nimbalyst-local/` (private notes), `.claude/`, `.env`
 * files, signing material, and a `node_modules` full of host-platform native
 * binaries. `COPY . .` would bake all of it into a layer that ships to
 * Cloudflare, and image layers are not deletable after the fact.
 *
 * So the context is staged: an explicit list of paths is copied into a scratch
 * directory, and `docker build` is pointed at that directory. Anything not
 * named here cannot reach the image, and anything that *looks* like a secret
 * inside an allowlisted directory is a hard failure rather than a silent skip
 * -- fail closed, because the failure mode of the other choice is publishing a
 * credential.
 */

/** Directories staged whole (minus SKIP_DIR_NAMES / secret-shaped files). */
export const ALLOWLISTED_DIRS = [
  // patch-package runs from the root `postinstall`; without these `npm ci` fails.
  'patches',
  // The headless runner and the four packages its build actually needs.
  'packages/node/src',
  'packages/runtime/src',
  'packages/runtime/scripts',
  'packages/extension-sdk/src',
  'packages/tracker-core/src',
  // Collaboration protocol build inputs and adapter type dependencies used by
  // the runtime's node closure.
  'packages/collab-protocol/src',
  'packages/collab-adapters/src',
  // The SQL migrations. Not restated anywhere: `packages/node/src/db/migrations.ts`
  // reads these exact files, as does the desktop app's MigrationRunner.
  'packages/electron/src/main/database/sqlite/schemas',
];

/**
 * Directories staged under a different path than they occupy in the checkout.
 *
 * The image's own launcher and smoke check live next to this file, but the
 * Dockerfile must reach them relative to the context root, so they are staged
 * flat as `bin/`.
 */
export const ALLOWLISTED_DIR_MAPPINGS = [
  { from: 'packages/cloudflare-sandbox/container/bin', to: 'bin' },
];

/**
 * Staged because the build needs them, deleted before the image is assembled.
 *
 * `bin/` holds the launcher the Dockerfile copies into `/opt/nimbalyst/bin`, and
 * the marker file is how `stage-build-context.mjs` recognises a staging
 * directory as its own before deleting it. Both have to exist in the context.
 * Neither belongs in `/opt/nimbalyst/app`, which is the whole context copied
 * forward -- a second copy of the launcher there makes it ambiguous which one
 * runs, and the marker is noise in a published layer. The builder stage removes
 * exactly these paths; `checks/image-pins.test.mjs` holds the two in sync.
 */
export const CONTEXT_ONLY_PATHS = ['bin', '.nimbalyst-build-context'];

/** Individual files staged by name. */
export const ALLOWLISTED_FILES = [
  'package.json',
  'package-lock.json',
  // `packages/tracker-core/tsconfig.json` extends this. Omitting it does not
  // fail resolution loudly -- tsc falls back to its ES5 defaults and the build
  // dies much later with a wall of "Property 'find' does not exist" and
  // "Cannot find name 'Set'". Found by the first real image build.
  'tsconfig.json',
  // The root `prepare` lifecycle script. It no-ops outside a git checkout, but
  // npm errors if the file the script names is missing.
  'scripts/install-git-hooks.mjs',
  'packages/node/tsconfig.json',
  'packages/node/nimbalyst-node.config.example.json',
  'packages/runtime/tsconfig.json',
  'packages/runtime/tsconfig.node.json',
  'packages/extension-sdk/tsconfig.json',
  'packages/tracker-core/tsconfig.json',
  'packages/collab-protocol/tsconfig.json',
  'packages/collab-protocol/tsconfig.build.json',
  'packages/collab-adapters/tsconfig.json',
];

/**
 * Every workspace's `package.json` is staged, and nothing else from workspaces
 * not listed above.
 *
 * `npm ci` validates the lockfile against the full workspace set. A workspace
 * whose directory is absent is not "excluded", it is a lockfile mismatch, and
 * the install aborts. A `package.json` is metadata -- names, versions, scripts
 * -- so staging all of them costs a few kilobytes and no secrets.
 */
export const STAGE_ALL_WORKSPACE_MANIFESTS = true;

/** Never descend into these, wherever they appear. */
export const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-node',
  'out',
  'out2',
  'build',
  'release',
  'coverage',
  '.vite',
  '.turbo',
  '.cache',
  '.vitest',
  // Tests are not part of any tsconfig the image builds, and they would drag
  // vitest into the type program.
  '__tests__',
  '__mocks__',
  'temptests',
]);

/**
 * Path segments that must never appear anywhere in the staged tree.
 *
 * These are the developer-private areas of this checkout. Reaching one means
 * the allowlist above was edited wrongly, so it aborts the stage rather than
 * skipping quietly.
 */
export const FORBIDDEN_SEGMENTS = new Set([
  'nimbalyst-local',
  '.claude',
  '.git',
  'node_modules',
  '.wrangler',
  '.ssh',
]);

/**
 * File names that look like credentials. Matched case-insensitively.
 *
 * Two shapes were assumed away in the first version of this list and are worth
 * naming, because both are what the tools that write these files actually
 * produce:
 *
 *  - **No extension.** The cloud CLIs write a file literally called
 *    `credentials`. Anchoring the pattern on `.json`/`.yaml`/`.txt` reads as
 *    thorough and matches none of them.
 *  - **Not the extension we remembered.** `wrangler.toml` was listed;
 *    Wrangler's JSON configuration was not, so the same secrets in
 *    `wrangler.json` passed.
 *
 * The list stays deliberately name-shaped rather than content-sniffing: a
 * container image is the wrong place for any of these regardless of what is
 * inside them, and `classifyEntry` turns a match into a hard failure with an
 * error that points at run-time configuration instead.
 */
export const SECRET_FILE_PATTERNS = [
  // Covers `.env`, `.env.production` -- and, via the second pattern, the
  // suffixed spellings (`local.env`, `prod.env`) the first one never saw.
  /^\.env(\..*)?$/i,
  /\.env$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|mobileprovision|cer|der|token)$/i,
  // Extension-less first, so `credentials` and `.credentials` match; the
  // broader `*credentials*` form stays extension-anchored so that source files
  // such as `useCredentials.tsx` are not swept up with them.
  /^\.?credentials$/i,
  /^.*credentials.*\.(json|ya?ml|txt)$/i,
  /^.*secrets?.*\.(json|ya?ml|txt)$/i,
  /^service-account.*\.json$/i,
  /^\.dev\.vars$/i,
  /^wrangler\.(toml|jsonc?)$/i,
];

/** True when a file name is secret-shaped and must never be staged. */
export function isSecretFileName(name) {
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Reject absolute paths, `..` traversal, and anything under a forbidden
 * segment. Returns the normalized POSIX-relative path.
 */
export function normalizeStagedPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('[stage] empty path');
  }
  if (relPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relPath)) {
    throw new Error(`[stage] absolute paths are not stageable: ${relPath}`);
  }
  const segments = relPath.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw new Error(`[stage] path escapes the repository root: ${relPath}`);
  }
  const forbidden = segments.find((s) => FORBIDDEN_SEGMENTS.has(s));
  if (forbidden) {
    throw new Error(`[stage] refusing to stage a private path (segment "${forbidden}"): ${relPath}`);
  }
  return segments.join('/');
}

/**
 * The decision for one directory entry encountered while walking an
 * allowlisted directory.
 *
 * Pure so the policy is testable without a filesystem: `'copy'` stages it,
 * `'skip'` drops a build artifact or test directory, and `'reject'` throws --
 * used only for entries that look like credentials, where continuing silently
 * is the dangerous outcome.
 */
export function classifyEntry({ name, isDirectory }) {
  if (isDirectory) {
    if (FORBIDDEN_SEGMENTS.has(name)) return 'skip';
    if (SKIP_DIR_NAMES.has(name)) return 'skip';
    return 'copy';
  }
  if (isSecretFileName(name)) return 'reject';
  // Editor scratch and OS noise; harmless but pointless in a layer.
  if (name === '.DS_Store' || name.endsWith('.tsbuildinfo')) return 'skip';
  return 'copy';
}

/**
 * Expand the root `package.json` "workspaces" globs to the directories that
 * exist, given a directory lister. Only the single-`*` trailing form this repo
 * uses is supported; anything else is an error rather than a guess.
 */
export function expandWorkspaceGlobs(globs, listDir) {
  const dirs = [];
  for (const glob of globs) {
    if (!glob.includes('*')) {
      dirs.push(normalizeStagedPath(glob));
      continue;
    }
    const match = /^(.*)\/\*$/.exec(glob);
    if (!match) {
      throw new Error(`[stage] unsupported workspace glob: ${glob}`);
    }
    const parent = normalizeStagedPath(match[1]);
    for (const child of listDir(parent)) {
      dirs.push(`${parent}/${child}`);
    }
  }
  return dirs;
}
