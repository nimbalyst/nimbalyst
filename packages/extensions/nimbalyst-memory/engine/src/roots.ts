/**
 * Multi-root path algebra. The engine was single-rooted by construction: every
 * `sourcePath` was a POSIX path relative to `EngineConfig.root` and `readDoc`
 * rejected anything resolving outside it. A `SourceSet` may now carry its own
 * `root`, which breaks two invariants that the rest of the engine leaned on:
 *
 * 1. **`sourcePath` is no longer unique relative-to-root.** A `README.md` under
 *    each root would collide on the chunk primary key and on the prune keyspace.
 *    Disambiguation: the primary root (`EngineConfig.root`) keeps bare relative
 *    paths, and every other root prefixes with `@<rootId>/`. Primary paths are
 *    therefore byte-identical to what a single-rooted store already holds, so
 *    adding a second root is purely additive — no citation, fact path, or
 *    existing index row changes meaning.
 * 2. **"Inside the root" is no longer a single comparison.** It becomes a
 *    set-membership test over the configured roots — see `resolveInRoots`, which
 *    is the guard that makes `read_doc` safe to expose. It is a membership test
 *    in both directions: an unrecognized `@id` falls back to the primary root
 *    (it does NOT unlock an arbitrary directory), and a path that resolves
 *    outside every configured root throws.
 *
 * Pure: no fs, no host imports. Everything here is a function of the config.
 */
import path from 'node:path';

/** Marks a `sourcePath` as belonging to a non-primary root. */
const ROOT_PREFIX = '@';

/**
 * A non-primary indexing root. The `id` becomes part of every `sourcePath`
 * derived from this root, so it is a persisted key: changing it re-keys the
 * shadow index (which is rebuildable, but citations held elsewhere are not).
 */
export interface SourceRoot {
  /**
   * Stable, `/`-free id used as the `sourcePath` prefix. Deterministic by
   * construction — it is configuration, not derived from a mutable path — so
   * `sourcePath`s round-trip identically across rebuilds.
   */
  id: string;
  /** Absolute directory. */
  path: string;
  /**
   * This root holds personal, machine-local content that must NEVER be routed
   * into a committed or shared replica (the phase-4 `memory/facts.jsonl`
   * exporter, team sync, anything leaving the machine). Downstream code decides
   * by reading this flag — via `MemoryEngine.isPersonalSourcePath()` for a
   * `sourcePath`, or `personalRoots()` for the root list. Structural, not a
   * comment: a new export path that forgets to filter has to have ignored a
   * property that is right next to the paths it is about to publish.
   */
  personal?: boolean;
}

/** A root as resolved for use: absolute, normalized, with the primary flagged. */
export interface ResolvedRoot {
  /** `null` for the primary root — its `sourcePath`s carry no prefix. */
  id: string | null;
  /** Absolute, normalized directory. */
  dir: string;
  personal: boolean;
}

/** Ids must not contain `/` (it terminates the prefix) and must be non-empty. */
export function isValidRootId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

/** True when `abs` is `root` itself or sits underneath it. */
function contains(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * The distinct roots for a config: the primary first, then each `SourceSet.root`
 * in declaration order. Throws on a configuration that would fork the keyspace
 * (a duplicate id pointing at a different directory, or one directory claimed
 * under two ids) — those produce silently duplicated or unreachable index rows,
 * and the config comes from us, not from user data.
 *
 * A source root that resolves to the primary directory is folded into the
 * primary rather than given a prefix, so one directory always has exactly one
 * keyspace.
 */
export function resolveRoots(
  primaryRoot: string,
  sources: Array<{ root?: SourceRoot }>
): ResolvedRoot[] {
  const primaryDir = path.resolve(primaryRoot);
  const roots: ResolvedRoot[] = [{ id: null, dir: primaryDir, personal: false }];
  const byId = new Map<string, ResolvedRoot>();
  const byDir = new Map<string, ResolvedRoot>([[primaryDir, roots[0]]]);

  for (const set of sources) {
    if (!set.root) continue;
    const { id } = set.root;
    if (!isValidRootId(id)) {
      throw new Error(`SourceSet.root.id is not a valid root id: ${JSON.stringify(id)}`);
    }
    const dir = path.resolve(set.root.path);
    const personal = set.root.personal === true;

    if (dir === primaryDir) continue; // same directory as the primary — one keyspace.

    const priorById = byId.get(id);
    if (priorById) {
      if (priorById.dir !== dir) {
        throw new Error(`SourceSet.root.id "${id}" is used for two directories: ${priorById.dir} and ${dir}`);
      }
      if (priorById.personal !== personal) {
        throw new Error(`SourceSet.root.id "${id}" is declared both personal and non-personal`);
      }
      continue;
    }
    const priorByDir = byDir.get(dir);
    if (priorByDir) {
      throw new Error(`Root directory ${dir} is claimed under two ids: "${priorByDir.id}" and "${id}"`);
    }

    const resolved: ResolvedRoot = { id, dir, personal };
    roots.push(resolved);
    byId.set(id, resolved);
    byDir.set(dir, resolved);
  }
  return roots;
}

/** The primary root (always first). */
export function primaryRoot(roots: ResolvedRoot[]): ResolvedRoot {
  return roots[0];
}

/** The resolved root a source set indexes against. */
export function rootForSet(roots: ResolvedRoot[], set: { root?: SourceRoot }): ResolvedRoot {
  if (!set.root) return primaryRoot(roots);
  const dir = path.resolve(set.root.path);
  return roots.find((r) => r.dir === dir) ?? primaryRoot(roots);
}

/** Compose a `sourcePath` from a root and a POSIX path relative to it. */
export function toSourcePath(root: ResolvedRoot, relPosix: string): string {
  if (root.id === null) return relPosix;
  return relPosix ? `${ROOT_PREFIX}${root.id}/${relPosix}` : `${ROOT_PREFIX}${root.id}`;
}

/**
 * Split a `sourcePath` back into its root and root-relative remainder.
 *
 * An `@<id>/` prefix resolves ONLY against a configured root id; an unknown id
 * is treated as a literal primary-root path (a repo really can hold a top-level
 * `@scope/` directory). That fallback cannot widen access — the caller still has
 * to clear `resolveInRoots`.
 */
export function parseSourcePath(
  roots: ResolvedRoot[],
  sourcePath: string
): { root: ResolvedRoot; rel: string } {
  if (sourcePath.startsWith(ROOT_PREFIX)) {
    const slash = sourcePath.indexOf('/');
    const id = slash === -1 ? sourcePath.slice(1) : sourcePath.slice(1, slash);
    const root = roots.find((r) => r.id === id);
    if (root) return { root, rel: slash === -1 ? '' : sourcePath.slice(slash + 1) };
  }
  return { root: primaryRoot(roots), rel: sourcePath };
}

/**
 * Resolve a `sourcePath` (or a bare primary-relative path) to an absolute path,
 * REQUIRING that it land inside one of the configured roots. Throws otherwise.
 *
 * This is the guard behind `read_doc`. Two properties matter and are tested:
 * the membership test is over the whole root set (adding a root must not weaken
 * the others), and there is no configuration that turns it off. Attribution
 * picks the deepest containing root so a nested root canonicalizes to itself
 * rather than to its ancestor.
 */
export function resolveInRoots(
  roots: ResolvedRoot[],
  sourcePath: string
): { abs: string; root: ResolvedRoot; sourcePath: string } {
  const { root, rel } = parseSourcePath(roots, sourcePath);
  const abs = path.resolve(root.dir, rel);

  const owner = roots
    .filter((r) => contains(r.dir, abs))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (!owner) {
    // Wording keeps the pre-multi-root "escapes engine root" phrasing that
    // callers and tests match on.
    throw new Error(`path escapes engine root (outside every configured root): ${sourcePath}`);
  }
  return { abs, root: owner, sourcePath: toSourcePath(owner, toPosix(path.relative(owner.dir, abs))) };
}

/**
 * Resolve an absolute path to its owning root plus root-relative POSIX path, or
 * null when it lies outside every root. The non-throwing counterpart to
 * `resolveInRoots`, for the watcher (which sees paths it did not derive).
 */
export function locateAbsolute(
  roots: ResolvedRoot[],
  abs: string
): { root: ResolvedRoot; rel: string } | null {
  const resolved = path.resolve(abs);
  const owner = roots
    .filter((r) => contains(r.dir, resolved))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
  if (!owner) return null;
  return { root: owner, rel: toPosix(path.relative(owner.dir, resolved)) };
}
