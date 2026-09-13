/**
 * Working out which Wrangler profile a directory actually resolves to.
 *
 * This exists because no command answers the question. Verified against the
 * installed wrangler 4.125.0:
 *
 *   - `wrangler auth current` does not exist. The command registry has only
 *     token, keyring, create, delete, activate, deactivate and list.
 *   - `wrangler whoami --profile <name>` is rejected outright: "--profile cannot
 *     be used with the whoami command as it only works on the currently active
 *     profile."
 *
 * So the only way to read a profile's identity is to run `whoami` from a
 * directory that resolves to it, and the only way to know a directory resolves
 * to it is to reproduce Wrangler's own resolution against the binding map that
 * `auth list` prints. {@link resolveProfileForDirectory} transcribes
 * `getProfileForDirectoryFromBindings` from the CLI bundle: longest bound path
 * wins, matching exactly or on a path-separator boundary, with `"default"` as
 * the fallback when nothing matches.
 *
 * A wrong answer here does not throw — it quietly authenticates as a different
 * account. Everything uncertain therefore fails closed.
 */

import * as path from "path";

import { SandboxOperationError } from "./errors";
import { stripAnsi } from "./wranglerCli";
import { isValidProfileName } from "./wranglerPaths";

/** The login/logout-managed profile. Cannot be created or bound. */
export const DEFAULT_PROFILE = "default";

/** Wrangler's `RESERVED_PROFILE_NAMES`, compared case-insensitively as it does. */
export const RESERVED_PROFILE_NAMES = [DEFAULT_PROFILE, "staging"] as const;

/**
 * True for names `auth create` and `auth activate` both refuse. It covers
 * `activate` as well as `create`, which is why the default profile's directory
 * can never be bound and has to be verified by fallback instead.
 */
export function isReservedProfileName(name: string): boolean {
  return (RESERVED_PROFILE_NAMES as readonly string[]).includes(
    name.toLowerCase()
  );
}

export interface ProfileBinding {
  name: string;
  boundDirectories: string[];
  /**
   * True when the printed directory list could not be split unambiguously.
   * See {@link bindingsAreAmbiguous}.
   */
  ambiguous: boolean;
}

/**
 * Parse the cli-table3 table `wrangler auth list` prints.
 *
 *   ┌─────────┬───────────────────┐
 *   │ Profile │ Bound Directories │
 *   ├─────────┼───────────────────┤
 *   │ work    │ /a/b, /a/c        │
 *   └─────────┴───────────────────┘
 *
 * The installed version renders with `wordWrap: false` and no `colWidths`, so a
 * row is never split across lines and a cell always holds the whole list. "-"
 * is Wrangler's placeholder for no bound directories.
 */
export function parseAuthListTable(output: string): ProfileBinding[] {
  const clean = stripAnsi(output);
  if (/No profiles found/i.test(clean)) return [];

  const cellLines = clean.split("\n").filter((line) => line.includes("│"));

  // An empty array is a meaningful answer here — it means "nothing is bound, so
  // every directory resolves to default" — and resolution acts on it. So it must
  // only ever come from output we positively recognised. Unfamiliar output, a
  // missing header, or a row we cannot read all fail closed instead, because
  // silently reporting "no bindings" would send an operation to the default
  // profile and therefore to whichever account that profile holds.
  if (cellLines.length === 0) {
    throw new SandboxOperationError("unknown", "auth-list-unrecognised");
  }

  const rows: ProfileBinding[] = [];
  let sawHeader = false;

  for (const line of cellLines) {
    const cells = line
      .split("│")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 2) {
      throw new SandboxOperationError(
        "unknown",
        "auth-list-unexpected-columns"
      );
    }

    const [name, dirs] = cells;
    if (name === "Profile" && dirs === "Bound Directories") {
      sawHeader = true;
      continue;
    }
    if (!isValidProfileName(name)) {
      throw new SandboxOperationError("unknown", "auth-list-unreadable-row");
    }

    const boundDirectories =
      !dirs || dirs === "-"
        ? []
        : dirs
            .split(",")
            .map((dir) => dir.trim())
            .filter(Boolean);
    rows.push({
      name,
      boundDirectories,
      // A comma inside a directory name splits one path into fragments. Any
      // fragment that is not an absolute path proves that happened; a path
      // containing ", " that still looks absolute is caught by requiring every
      // fragment to exist as a plausible path root rather than guessing.
      ambiguous: boundDirectories.some(
        (dir) => !path.isAbsolute(dir) || dir.includes(",")
      ),
    });
  }

  if (!sawHeader) {
    throw new SandboxOperationError("unknown", "auth-list-missing-header");
  }
  return rows;
}

/**
 * `auth list` comma-joins bound directories, so a directory whose own name
 * contains a comma is indistinguishable from two directories. Wrangler always
 * stores absolute resolved paths, so a non-absolute fragment proves a single
 * path was split into pieces and the whole map is untrustworthy.
 */
export function bindingsAreAmbiguous(bindings: ProfileBinding[]): boolean {
  return bindings.some(
    (binding) =>
      binding.ambiguous ||
      binding.boundDirectories.some((dir) => !dir || !path.isAbsolute(dir))
  );
}

export interface ResolvedProfile {
  profile: string;
  /** `binding` when a bound ancestor matched; `default` when nothing did. */
  source: "binding" | "default";
  /** The bound directory that won, when `source === 'binding'`. */
  boundDirectory: string | null;
}

/**
 * Reproduce Wrangler's directory-to-profile resolution.
 *
 * @throws when the binding map is ambiguous. Failing at this level rather than
 * only in the callers matters: the fallback answer is `"default"`, so a silent
 * pass would not look like an error at all — it would look like a directory
 * that legitimately has no binding, and the operation would run against the
 * default profile's account.
 */
export function resolveProfileForDirectory(
  directory: string,
  bindings: ProfileBinding[]
): ResolvedProfile {
  if (bindingsAreAmbiguous(bindings)) {
    throw new SandboxOperationError("unknown", "binding-map-ambiguous");
  }
  const target = path.resolve(directory);

  const entries: Array<{ dir: string; profile: string }> = [];
  for (const binding of bindings) {
    for (const dir of binding.boundDirectories) {
      entries.push({ dir: path.resolve(dir), profile: binding.name });
    }
  }
  entries.sort((a, b) => b.dir.length - a.dir.length);

  for (const entry of entries) {
    if (target === entry.dir) {
      return {
        profile: entry.profile,
        source: "binding",
        boundDirectory: entry.dir,
      };
    }
    if (target.startsWith(entry.dir) && target[entry.dir.length] === path.sep) {
      return {
        profile: entry.profile,
        source: "binding",
        boundDirectory: entry.dir,
      };
    }
  }
  return { profile: DEFAULT_PROFILE, source: "default", boundDirectory: null };
}

export type ProfileResolutionVerdict =
  | { ok: true; resolved: ResolvedProfile }
  | {
      ok: false;
      reason: "ambiguous-bindings" | "resolves-elsewhere";
      resolved: ResolvedProfile | null;
    };

/**
 * Does `directory` resolve to `expectedProfile`?
 *
 * Returns a verdict rather than throwing, because a negative answer is used for
 * two different things: deciding whether a bind is still needed, and, after
 * binding, refusing the operation outright.
 *
 * An ambiguous binding map is never `ok`, even when the naive resolution would
 * have agreed. For the default profile the check is "nothing binds an ancestor
 * of this directory", and an unparseable map cannot establish that.
 */
export function checkProfileResolution(
  directory: string,
  expectedProfile: string,
  bindings: ProfileBinding[]
): ProfileResolutionVerdict {
  if (bindingsAreAmbiguous(bindings)) {
    return { ok: false, reason: "ambiguous-bindings", resolved: null };
  }
  const resolved = resolveProfileForDirectory(directory, bindings);
  if (resolved.profile !== expectedProfile) {
    return { ok: false, reason: "resolves-elsewhere", resolved };
  }
  return { ok: true, resolved };
}

/**
 * Throwing form of {@link checkProfileResolution}, for the call sites that have
 * already done whatever binding they were going to do and must now either
 * proceed as the right profile or stop.
 */
export function assertResolvesTo(
  directory: string,
  expectedProfile: string,
  bindings: ProfileBinding[]
): ResolvedProfile {
  const verdict = checkProfileResolution(directory, expectedProfile, bindings);
  if (!verdict.ok) {
    throw new SandboxOperationError(
      "not-authenticated",
      verdict.reason === "ambiguous-bindings"
        ? "binding-map-ambiguous"
        : "profile-resolution-mismatch"
    );
  }
  return verdict.resolved;
}
