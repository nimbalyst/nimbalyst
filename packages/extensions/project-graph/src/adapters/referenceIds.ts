/**
 * Canonical node ids for cross-source references.
 *
 * A session's `linkedTrackerItemIds` does not only contain tracker item ids. In
 * this workspace 148 sessions carry entries like
 * `file:nimbalyst-local/plans/multi-desktop-session-sync.md` — a reference to a
 * markdown plan, not to a tracker row. Prefixing those with `tracker:` minted
 * `tracker:file:nimbalyst-local/...`, an id no source can ever own, which then
 * rendered as a tracker item that is permanently missing.
 *
 * So a reference is resolved to whichever indexed source actually owns it:
 *
 *  - a `file:` reference under a plan root becomes `plan:<relative path>`
 *  - under a docs root, `doc:<relative path>`
 *  - under the memory facts root, `memory:<relative path>`
 *  - anything else stays `file:<relative path>` — an honest unresolved file
 *    identity, never a tracker one
 *  - everything without the `file:` prefix is a tracker id
 *
 * Paths are made workspace-relative first, so an absolute and a relative
 * reference to the same file produce the same id and dedupe.
 */
import { relativizeToWorkspace } from './paths';

/** Roots the plan source enumerates. Shared so ids and enumeration agree. */
export const PLAN_ROOTS = ['nimbalyst-local/plans'] as const;
/** Roots the doc source enumerates. */
export const DOC_ROOTS = ['docs', 'design', 'nimbalyst-local/architecture'] as const;
/** Root the memory source enumerates (the memory extension's facts directory). */
export const MEMORY_ROOTS = ['nimbalyst-local/voice-memory'] as const;

export type ReferenceKind = 'tracker' | 'plan' | 'doc' | 'memory' | 'file';

export interface ResolvedReference {
  id: string;
  kind: ReferenceKind;
  /** The workspace-relative path, for a file-backed reference. */
  path?: string;
}

export interface ReferenceRoots {
  workspacePath: string;
  planRoots?: readonly string[];
  docRoots?: readonly string[];
  memoryRoots?: readonly string[];
}

const FILE_PREFIX = 'file:';

function underAnyRoot(path: string, roots: readonly string[]): boolean {
  return roots.some(root => path === root || path.startsWith(`${root}/`));
}

/**
 * Canonical node id for one recorded reference.
 *
 * Pure and total: every input yields an id, because dropping a reference the
 * user recorded would be a worse answer than an unresolved one.
 */
export function resolveReferenceId(raw: string, roots: ReferenceRoots): ResolvedReference {
  if (!raw.startsWith(FILE_PREFIX)) return { id: `tracker:${raw}`, kind: 'tracker' };

  const rawPath = raw.slice(FILE_PREFIX.length);
  // An absolute path outside the workspace relativizes to null; keep the
  // original text so the reference is still identifiable rather than becoming
  // `file:` with nothing after it.
  const path = relativizeToWorkspace(rawPath, roots.workspacePath) ?? rawPath;

  if (underAnyRoot(path, roots.planRoots ?? PLAN_ROOTS)) return { id: `plan:${path}`, kind: 'plan', path };
  if (underAnyRoot(path, roots.memoryRoots ?? MEMORY_ROOTS)) return { id: `memory:${path}`, kind: 'memory', path };
  if (underAnyRoot(path, roots.docRoots ?? DOC_ROOTS)) return { id: `doc:${path}`, kind: 'doc', path };
  return { id: `file:${path}`, kind: 'file', path };
}

/**
 * The canonical id for a `file:`-prefixed node id, if a source owns that path.
 * Returns `null` when the id is not a file reference or maps to nothing better.
 *
 * Used when resolving an endpoint: a stored `file:` id from an older index can
 * still be answered by the plan or doc source.
 */
export function canonicalFileNodeId(nodeId: string, roots: ReferenceRoots): string | null {
  if (!nodeId.startsWith(FILE_PREFIX)) return null;
  const resolved = resolveReferenceId(nodeId, roots);
  return resolved.kind === 'file' ? null : resolved.id;
}
