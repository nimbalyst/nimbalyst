/**
 * Resolve the better-sqlite3 constructor for whichever channel this `nim` is.
 *
 * There are two, and they load the binding from different places:
 *
 * - **npm** (`npm i -g @nimbalyst/cli`): better-sqlite3 is an optional
 *   dependency and `npm install` usually puts a loadable copy next to us. When
 *   it could not, only the commands that open the database fail, with a message
 *   saying so (see `assertInstalled`).
 * - **bundled**: `nim` ships inside the Nimbalyst app and has no node_modules
 *   of its own. It loads the copy the app already carries at
 *   `<Resources>/node_modules/better-sqlite3`, which is per-target (afterPack
 *   prunes the other seven prebuilds) and already covered by the app's code
 *   signature and notarization. Shipping a second binary would mean a second
 *   thing to sign and 2 MB of duplicate.
 *
 * The channel is DECLARED, not probed: `bin/cli-bundled.ts` calls
 * `useBundledSqlite()` before anything opens a database, and each branch then
 * has exactly one place it will load from. That distinction is the whole point
 * of this file. The tempting shape -- try the app's copy, fall back to a bare
 * `require('better-sqlite3')` -- is what must not exist here: better-sqlite3
 * 13's prebuilds are Node-API 10, and loading one on a Node-API 9 host does not
 * throw, it SIGSEGVs. A wrong copy is therefore not degraded behaviour, it is a
 * crash with nothing printed and nothing to catch. Every failure below names
 * what was looked for and where instead.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

type SqliteCtor = typeof Database;

const require = createRequire(import.meta.url);

/**
 * The Node-API version the shipped prebuilds need. Node-API 9 hosts (Node 18
 * and Node 20) segfault on load rather than throwing, so this has to be checked
 * BEFORE the binding is opened -- afterwards there is no process left to report
 * anything. Node-API 10 (Node 22 and 24) loads and round-trips, which is the
 * same floor as better-sqlite3 13's own `engines.node: ">=22"` and this
 * package's.
 *
 * `engines` only protects the npm channel, because npm is what enforces it. A
 * bundled `nim` runs under whatever Node is on the user's PATH, so this check
 * is the only thing standing between a Node 20 user and an unexplained crash.
 */
const REQUIRED_NAPI = 10;

/** Set by the bundled entry point. Null means the npm channel. */
let bundledResourcesDir: string | null = null;
let cachedCtor: SqliteCtor | null = null;

/**
 * Declare that this process is the bundled `nim` and its binding lives inside
 * the app at `resourcesDir`. Must be called before the first `openDatabase()`.
 */
export function useBundledSqlite(resourcesDir: string): void {
  bundledResourcesDir = resourcesDir;
  cachedCtor = null;
}

/**
 * Derive the app's Resources directory from the bundled entry point's own
 * location: `<Resources>/nim/dist/bin/cli-bundled.js` -> `<Resources>`.
 *
 * realpath first, because the PATH entry for a bundled `nim` is a symlink into
 * the app: the derivation has to be relative to where the file really is, not
 * where it was invoked from. If packaging moves the entry, this returns the
 * wrong directory and `loadBundled` reports exactly which directory that was --
 * it never searches for a better answer.
 */
export function resolveBundledResourcesDir(entryUrl: string): string {
  const entryFile = realpathSync(fileURLToPath(entryUrl));
  return nodePath.resolve(nodePath.dirname(entryFile), '..', '..', '..');
}

/** Test seam: forget the declared channel and any memoized constructor. */
export function resetSqliteChannel(): void {
  bundledResourcesDir = null;
  cachedCtor = null;
}

/**
 * Mirror of better-sqlite3's `lib/binding.js#getPrebuildPath()` naming. Used
 * only to describe a failure -- resolution itself is left to the package's own
 * binding.js so the two cannot drift into disagreeing about which file to load.
 */
function hostPrebuildName(): string {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const isLinuxMusl =
    process.platform === 'linux' && !report?.header?.glibcVersionRuntime;
  const platform = isLinuxMusl ? 'linuxmusl' : process.platform;
  return `${platform}-${process.arch}.node`;
}

function describePrebuilds(packageDir: string): string {
  const dir = nodePath.join(packageDir, 'prebuilds');
  if (!existsSync(dir)) return '(no prebuilds directory)';
  const names = readdirSync(dir).filter((f) => f.endsWith('.node'));
  return names.length ? names.join(', ') : '(empty)';
}

function assertNodeApiFloor(): void {
  const napi = Number(process.versions.napi);
  if (Number.isFinite(napi) && napi >= REQUIRED_NAPI) return;
  throw new Error(
    `this Node is too old to load Nimbalyst's SQLite binding.\n` +
      `  running:  Node ${process.versions.node} (Node-API ${process.versions.napi ?? 'unknown'})\n` +
      `  required: Node 22 or newer (Node-API ${REQUIRED_NAPI})\n` +
      `Older versions do not fail cleanly here, they crash the process. Upgrade Node and retry.`,
  );
}

/**
 * Require the package AND open a throwaway handle through it.
 *
 * The second half is the part that matters: better-sqlite3 resolves its native
 * binding lazily, inside the Database constructor, so `require()` alone
 * succeeds even when there is no prebuild this host can load. Without the probe
 * the failure escapes as a bare "Cannot find module .../build/Release/
 * better_sqlite3.node" from deep inside the package, naming a path that is not
 * even where we looked -- which is exactly the uninformative crash this file
 * exists to prevent.
 */
function loadFrom(
  specifier: string,
  nativeBinding: string | undefined,
  describeFailure: (cause: string) => string,
): SqliteCtor {
  try {
    const loaded = require(specifier);
    const ctor = (loaded as { default?: SqliteCtor }).default ?? (loaded as SqliteCtor);
    if (typeof ctor !== 'function') {
      throw new Error(`module at ${specifier} did not export a constructor`);
    }
    const probe = new ctor(':memory:', nativeBinding ? { nativeBinding } : {});
    probe.close();
    return ctor;
  } catch (err) {
    // First line only: a module-resolution failure appends its whole require
    // stack, which repeats paths already named above and buries the closing
    // line telling the user what to do about it.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(describeFailure(raw.split('\n')[0]));
  }
}

function loadBundled(resourcesDir: string, nativeBinding: string | undefined): SqliteCtor {
  const packageDir = nodePath.join(resourcesDir, 'node_modules', 'better-sqlite3');
  if (!existsSync(packageDir)) {
    throw new Error(
      `the SQLite binding that ships with the Nimbalyst app is missing.\n` +
        `  looked for:    ${packageDir}\n` +
        `  app resources: ${resourcesDir}\n` +
        `This copy of nim only loads the binding inside the app. Reinstall Nimbalyst, ` +
        `or install the standalone CLI with \`npm i -g @nimbalyst/cli\`.`,
    );
  }
  return loadFrom(
    packageDir,
    nativeBinding,
    (cause) =>
      `could not load the SQLite binding that ships with the Nimbalyst app.\n` +
      `  package:           ${packageDir}\n` +
      `  expected prebuild: prebuilds/${hostPrebuildName()}\n` +
      `  prebuilds present: ${describePrebuilds(packageDir)}\n` +
      `  cause:             ${cause}\n` +
      `The app was built for a different platform or architecture than this shell is running.`,
  );
}

/**
 * better-sqlite3 is an OPTIONAL dependency on the npm channel: a host where its
 * prebuild fails to install still gets a working `nim` for everything that does
 * not read the app database (help, `nim wiki`, `nim mcp`). That only holds while
 * nothing imports it at module load -- type-only imports elsewhere, the require
 * here -- so this is where an absent package surfaces, and it should say that
 * the package is optional rather than look like a broken install.
 */
function assertInstalled(): void {
  try {
    require.resolve('better-sqlite3');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'MODULE_NOT_FOUND') throw err;
    throw new Error(
      `better-sqlite3 is not installed, and this command reads the Nimbalyst database directly.\n` +
        `  resolved from: ${nodePath.dirname(fileURLToPath(import.meta.url))}\n` +
        `It is an optional dependency of @nimbalyst/cli and its install was skipped or failed on this machine.\n` +
        `Start the Nimbalyst app so nim can use it instead, or reinstall with \`npm i -g @nimbalyst/cli --include=optional\`.`,
    );
  }
}

function loadFromNodeModules(nativeBinding: string | undefined): SqliteCtor {
  assertInstalled();
  return loadFrom(
    'better-sqlite3',
    nativeBinding,
    (cause) =>
      `could not load better-sqlite3.\n` +
      `  resolved from: ${nodePath.dirname(fileURLToPath(import.meta.url))}\n` +
      `  cause:         ${cause}\n` +
      `Reinstall the CLI with \`npm i -g @nimbalyst/cli\`.`,
  );
}

/** The better-sqlite3 constructor for this channel. Memoized. */
export function loadSqliteCtor(): SqliteCtor {
  if (cachedCtor) return cachedCtor;
  assertNodeApiFloor();
  const override = nativeBindingOverride();
  cachedCtor = bundledResourcesDir
    ? loadBundled(bundledResourcesDir, override)
    : loadFromNodeModules(override);
  return cachedCtor;
}

/**
 * Explicit native-binding override, honored in both channels.
 *
 * vitest's globalSetup uses this to point at an isolated prebuild without
 * disturbing the workspace installation. The name is Nimbalyst-specific, so a
 * value in the environment is a deliberate choice rather than something
 * inherited by accident -- but it is still validated here, because handing a
 * path that does not exist to the loader produces an opaque dlopen error, and
 * handing it one built for the wrong Node-API produces no error at all.
 */
export function nativeBindingOverride(): string | undefined {
  const value = process.env.NIMBALYST_BETTER_SQLITE3_NATIVE;
  if (!value) return undefined;
  if (!existsSync(value)) {
    throw new Error(
      `NIMBALYST_BETTER_SQLITE3_NATIVE points at a file that does not exist.\n` +
        `  value: ${value}\n` +
        `Unset it, or point it at a better-sqlite3 .node binding.`,
    );
  }
  return value;
}
