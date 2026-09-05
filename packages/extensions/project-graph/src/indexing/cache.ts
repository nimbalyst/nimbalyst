/**
 * Index persistence through `host.storage`.
 *
 * Never `localStorage` — the renderer is forbidden from using it (CLAUDE.md),
 * and extension storage is namespaced and workspace-scoped, which is exactly
 * the scope an index has.
 *
 * The cache is a convenience, never a correctness dependency: a miss, a version
 * mismatch, or an oversized payload all just mean the index loads from source.
 * So every failure here is swallowed deliberately rather than surfaced — the
 * one thing that must not happen is a caching problem blocking a load.
 */
import type { PanelHost } from '@nimbalyst/extension-sdk';
import type { ProjectGraphEdge, ProjectGraphNode } from '../types';
import type { SourceCoverage } from './types';

const STORAGE_KEY = 'projectIndex.v1';
const CACHE_VERSION = 1;

/**
 * Ceiling on the serialized payload. Extension storage is a settings store, not
 * a database; a multi-megabyte blob written on every load would be a
 * performance regression dressed as an optimization. Over the ceiling, the
 * cache is skipped and the next load reads from source.
 */
const MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;

/**
 * Fields kept in the cached projection.
 *
 * `fields.data` is deliberately absent. It carries the raw tracker blob and the
 * session activity log, and it is the overwhelming bulk of an indexed record:
 * measured on this workspace, tracker `data` alone is 26.6 MB across 5,150 rows
 * (5.2 KB average) and session `metadata` averages 2.5 KB across 6,253 rows.
 * Caching records whole put every real corpus over the size ceiling, so the
 * cache silently did nothing for exactly the workspaces it existed to speed up.
 *
 * What survives is what a warm first paint needs; the full blobs come back with
 * the next real load.
 */
const CACHED_FIELD_KEYS = [
  'id',
  'path',
  'issueKey',
  'issueNumber',
  'documentPath',
  'archived',
  'lastActivityAt',
  'updatedAtMs',
  'createdAt',
  'phase',
  'rollup',
] as const;

export interface CachedSourceSlice {
  records: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  coverage: SourceCoverage;
}

/**
 * Reduce a record to the cacheable projection. Marks the result
 * `fields.cachedLite` so a consumer reading a hydrated state can tell that the
 * detail bag is absent by design rather than empty at the source.
 */
export function toCachedRecord(record: ProjectGraphNode): ProjectGraphNode {
  const fields: Record<string, unknown> = { cachedLite: true };
  for (const key of CACHED_FIELD_KEYS) {
    const value = record.fields?.[key];
    if (value !== undefined) fields[key] = value;
  }
  return { ...record, fields };
}

export interface CachedIndex {
  version: number;
  generatedAt: number;
  /**
   * The options the cache was BUILT under. A cache written with archived
   * records included, or with a source the shell has since switched off, is not
   * usable now: hydrating it would flash evidence the user asked not to see.
   */
  scope: CacheScope;
  sources: Record<string, CachedSourceSlice>;
}

export interface CacheScope {
  includeArchived: boolean;
  /** Enabled source ids, sorted, so the comparison is order-independent. */
  enabledSources: string[];
}

export function cacheScopeOf(options: {
  includeArchived: boolean;
  sources: Record<string, boolean>;
}): CacheScope {
  return {
    includeArchived: options.includeArchived,
    enabledSources: Object.entries(options.sources)
      .filter(([, enabled]) => enabled !== false)
      .map(([id]) => id)
      .sort(),
  };
}

function sameScope(a: CacheScope, b: CacheScope): boolean {
  return (
    a.includeArchived === b.includeArchived &&
    a.enabledSources.length === b.enabledSources.length &&
    a.enabledSources.every((id, i) => id === b.enabledSources[i])
  );
}

/** A stored slice is only usable if it is actually shaped like one. */
function isValidSlice(value: unknown): value is CachedSourceSlice {
  if (!value || typeof value !== 'object') return false;
  const slice = value as Partial<CachedSourceSlice>;
  return (
    Array.isArray(slice.records) &&
    Array.isArray(slice.edges) &&
    !!slice.coverage &&
    typeof slice.coverage === 'object' &&
    slice.records.every(r => r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string')
  );
}

/**
 * Read the cache, or `null` when it is absent, stale, written under a different
 * scope, or malformed.
 *
 * Every rejection is silent and simply means "load from source" — a caching
 * problem must never block or corrupt a load.
 */
export async function readCachedIndex(host: PanelHost, scope: CacheScope): Promise<CachedIndex | null> {
  try {
    const raw = host.storage?.get<CachedIndex>(STORAGE_KEY);
    if (!raw || raw.version !== CACHE_VERSION) return null;
    if (!raw.sources || typeof raw.sources !== 'object' || Array.isArray(raw.sources)) return null;
    if (!raw.scope || !sameScope(raw.scope, scope)) return null;
    // One bad slice invalidates the whole cache rather than being skipped: a
    // partial hydrate would look like a complete one with records missing.
    for (const slice of Object.values(raw.sources)) {
      if (!isValidSlice(slice)) return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export async function writeCachedIndex(host: PanelHost, index: CachedIndex): Promise<void> {
  if (!host.storage?.set) return;
  try {
    const serialized = JSON.stringify(index);
    if (serialized.length > MAX_SERIALIZED_BYTES) {
      // Drop any stale entry rather than leaving a smaller, older index behind
      // that would read as current.
      await host.storage.delete(STORAGE_KEY).catch(() => undefined);
      return;
    }
    await host.storage.set(STORAGE_KEY, index);
  } catch {
    // A storage failure must never fail a load.
  }
}

export async function clearCachedIndex(host: PanelHost): Promise<void> {
  try {
    await host.storage?.delete(STORAGE_KEY);
  } catch {
    // Ignored for the same reason as above.
  }
}
