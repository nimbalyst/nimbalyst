/**
 * Contract for the incremental project index.
 *
 * The index is deliberately NOT the old snapshot loader with a bigger limit.
 * Three things separate it:
 *
 *  - **It indexes light metadata for the whole eligible corpus**, by page,
 *    rather than the newest N records. A session that was created two years ago
 *    and worked on last week is in the index, because "newest by creation" was
 *    the predicate that hid it.
 *  - **It never lays anything out.** Retrieval and aggregation are separate from
 *    geometry; nothing here calls the force or inventory layouts.
 *  - **It reports what it did not get.** Every source carries coverage saying
 *    how many records it indexed, out of how many, whether that is complete,
 *    and why not. A paged sample is never presented as a total.
 */
import type { PanelHost } from '@nimbalyst/extension-sdk';
import type { ProjectGraphEdge, ProjectGraphNode } from '../types';
import type { EventScopeConfig, ResolvedEventScope } from './eventScope';

export type IndexSourceId =
  | 'sessions'
  | 'trackers'
  | 'git'
  | 'plans'
  | 'docs'
  | 'github'
  | 'memory';

/**
 * Indexing order, and it is load-bearing rather than alphabetical.
 *
 * Records paint as they arrive on a first load, so the cheap local metadata a
 * user is actually waiting on goes first and the slow or optional sources go
 * last: local database, then the filesystem walks, then the git history walk,
 * then the network. Queueing sessions behind a GitHub round trip would leave
 * the pane empty for the duration of someone else's rate limit.
 */
export const INDEX_SOURCE_IDS: readonly IndexSourceId[] = [
  'sessions',
  'trackers',
  'plans',
  'docs',
  'memory',
  'git',
  'github',
];

export interface ProjectIndexOptions {
  /** Per-source enable/disable. An omitted source is enabled. */
  sources?: Partial<Record<IndexSourceId, boolean>>;
  /**
   * Include archived records. Default true — the August timeframe design
   * records archived-visible-by-default, and archival is not completion.
   */
  includeArchived?: boolean;
  /**
   * Horizon in ms for EVENT and detail retrieval (commit bodies, file
   * evidence). `null` means no horizon. Equivalent to an `eventScope` window
   * ending now; `eventScope` wins when both are set.
   *
   * Metadata headers are deliberately NOT horizon-scoped: an old record that
   * was active recently must still be indexed, which a creation-time predicate
   * cannot express.
   */
  historyHorizonMs?: number | null;
  /**
   * Bounds for event and detail retrieval, plus the period a comparison is made
   * against. Defaults to all history; see `eventScope.ts`.
   */
  eventScope?: EventScopeConfig;
  /**
   * Explicit per-source ceiling. **An omitted source has NO limit** — there is
   * no built-in default, because a default ceiling silently capped a corpus the
   * shell had explicitly asked to index in full. Reaching a ceiling that WAS
   * set records `truncated` and a reason; nothing is ever dropped silently.
   */
  safetyMax?: Partial<Record<IndexSourceId, number>>;
  /** Starting page size. The scheduler adapts from measured page duration. */
  pageSize?: number;
  /** Persist the light index through `host.storage`. Default true. */
  cache?: boolean;
}

export interface ResolvedIndexOptions {
  sources: Record<IndexSourceId, boolean>;
  includeArchived: boolean;
  historyHorizonMs: number | null;
  eventScope: EventScopeConfig;
  safetyMax: Partial<Record<IndexSourceId, number>>;
  pageSize: number;
  cache: boolean;
}

export const DEFAULT_PAGE_SIZE = 500;

export type SourceAvailability = 'available' | 'disabled' | 'unavailable' | 'error';

export interface SourceCoverage {
  sourceId: IndexSourceId;
  label: string;
  enabled: boolean;
  availability: SourceAvailability;
  /** Why a source is unavailable or errored. Never empty when it is either. */
  message?: string;
  /** Light records placed in the index. */
  indexed: number;
  /**
   * Authoritative total for the declared scope, or `null` when the source
   * cannot be counted without doing the work (git across all refs, a service).
   *
   * A null total does NOT imply incompleteness — see `complete`.
   */
  total: number | null;
  /**
   * METADATA completeness: an authoritative enumeration ran to exhaustion
   * without truncating or erroring, and did not fall short of a known total.
   *
   * Exhaustion is the signal, not the count. Git across all refs and a
   * filesystem walk have no cheap `COUNT`, but paging them until they stop
   * handing over pages IS the authoritative answer; demanding a denominator
   * would report every such source as permanently incomplete.
   *
   * This says nothing about event history — see `events`.
   */
  complete: boolean;
  truncated: boolean;
  truncationReason?: string;
  /** Records whose bodies/file evidence were fetched on demand. */
  detailLoaded: number;
  /**
   * EVENT history, which is scoped and retrieved separately from metadata.
   *
   * Full metadata with no events is the normal state for most sources, and the
   * two must not share one flag: `complete: true` on a header-only source
   * would otherwise read as "all of this record's history is here".
   */
  events: {
    /**
     * Whether this source can answer a windowed event query AT ALL.
     *
     * Only git can today. For every other source "no events" is a capability
     * fact, not an outcome of the window that was requested, and the UI needs
     * to say those two different things differently.
     */
    support: 'none' | 'window';
    /** Has any event or detail retrieval happened for this source at all. */
    retrieved: boolean;
    scope: 'all-history' | 'windowed' | 'none';
    /** Bounds ACTUALLY retrieved. Null until a real event query was fulfilled. */
    window: { startMs: number; endMs: number } | null;
    /** Mirrors {@link SourceCoverage.eventHistoryComplete}. */
    complete: boolean;
    reason?: string;
  };
  /**
   * Event history covering the whole indexed metadata scope for this source.
   *
   * Defaults to FALSE and only becomes true when a source actually fulfilled an
   * unbounded event query. A full period-over-period comparison is only sound
   * when every enabled source reports true — see
   * {@link eventHistoryCompleteForAll}.
   */
  eventHistoryComplete: boolean;
  /**
   * Event bounds ACTUALLY RETRIEVED, or null when nothing was.
   *
   * Never the requested window. Falling back to the request labelled every
   * source — documents, memory, plain headers — with "retrieved Jun 7 - Sep 5"
   * merely because that range had been asked for, which is a provenance claim
   * none of them can support.
   */
  window: { startMs: number | null; endMs: number | null } | null;
  pages: number;
  /**
   * When this source was last enumerated. Every `refresh` re-enumerates the
   * source in full — there is no delta protocol against these backends — so
   * this is a true "as of", not the age of the oldest unrefreshed record.
   */
  lastIndexedAt: number;
  /**
   * One line describing the declared scope, for display next to the counts:
   * "All sessions in this workspace, including archived."
   */
  scopeDescription?: string;
}

export interface IndexProgress {
  phase: 'idle' | 'counting' | 'indexing' | 'reconciling' | 'done' | 'cancelled' | 'error';
  activeSourceId?: IndexSourceId;
  completedSources: number;
  totalSources: number;
  recordsIndexed: number;
  startedAt: number;
  updatedAt: number;
}

export interface SourceTiming {
  /** Availability probe and count. Recorded even for a source that never paged. */
  prepareMs: number;
  /** Sum of page durations. Excludes `prepareMs` and inter-page yields. */
  totalMs: number;
  pages: number;
  slowestPageMs: number;
  averagePageMs: number;
}

export interface ProjectIndexState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Fencing token. A publish from a superseded generation is discarded. */
  generation: number;
  /** Light metadata only. No transcripts, no document bodies. */
  records: ProjectGraphNode[];
  /**
   * Raw relations, INCLUDING ones whose endpoint is not an indexed record.
   * Consumers that describe absence must consult `unresolvedEdgeIds` before
   * saying a source recorded nothing.
   */
  edges: ProjectGraphEdge[];
  unresolvedEdgeIds: string[];
  coverage: Record<IndexSourceId, SourceCoverage>;
  progress: IndexProgress;
  timings: Partial<Record<IndexSourceId, SourceTiming>>;
  /**
   * True when this state came from the persisted cache rather than a load.
   *
   * Cached records are a LITE projection — `fields.data` is absent and each
   * carries `fields.cachedLite`. A consumer that derives durable structure
   * (area geometry, a stable registry) should wait for a `ready` state with
   * `fromCache: false`, so nothing has to be rebuilt and shifted afterwards.
   */
  fromCache: boolean;
  generatedAt: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Source plugin contract
// ---------------------------------------------------------------------------

/**
 * Cooperative cancellation. A superseded load stops issuing queries at its next
 * page boundary rather than racing to completion and publishing stale results.
 */
export interface CancelSignal {
  readonly cancelled: boolean;
  throwIfCancelled(): void;
}

export class CancelledError extends Error {
  constructor() {
    super('Index load cancelled');
    this.name = 'CancelledError';
  }
}

export interface IndexSourceContext {
  host: PanelHost;
  options: ResolvedIndexOptions;
  /**
   * Resolved event/detail bounds for this run. Sources bound their EVENT
   * retrieval by `current`; none of them may bound record enumeration by it.
   */
  eventScope: ResolvedEventScope;
  signal: CancelSignal;
}

export interface SourcePrepareResult {
  availability: SourceAvailability;
  message?: string;
  /** `null` when the scope cannot be counted cheaply. */
  total: number | null;
  window?: { startMs: number | null; endMs: number | null } | null;
  /**
   * Set when the source truncated during ENUMERATION, before any page ran — a
   * filesystem walk that hit its ceiling while listing. Reporting it only from
   * the paging loop let a capped enumeration read as complete.
   */
  truncated?: boolean;
  truncationReason?: string;
  /** One line describing what this source declared it would index. */
  scope?: string;
  /**
   * Whether this source can answer a windowed event query at all. Defaults to
   * `'none'`: most sources index metadata and have no event history to fetch,
   * and saying so is different from having been asked and found nothing.
   */
  eventSupport?: 'none' | 'window';
  /**
   * Whether running this source's pagination to exhaustion proves it returned
   * everything in scope. Defaults to `'authoritative'`, which is true of keyset
   * enumeration, a filesystem walk, `git log --all`, and REST paging to a short
   * page.
   *
   * A source that can only sample, or whose backend may drop rows between
   * pages, declares `'bounded'` and can then never report `complete`.
   */
  enumeration?: 'authoritative' | 'bounded';
}

export interface IndexPage {
  records: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  /** Opaque continuation token. `undefined` means the source is exhausted. */
  cursor?: string;
  /** Rows examined, which can exceed `records.length` when rows aggregate. */
  rows: number;
}

export interface IndexSource {
  id: IndexSourceId;
  label: string;
  /** Cheap availability probe plus an authoritative count where one exists. */
  prepare(ctx: IndexSourceContext): Promise<SourcePrepareResult>;
  /** Fetch one page. `pageSize` is chosen by the scheduler. */
  page(ctx: IndexSourceContext, cursor: string | undefined, pageSize: number): Promise<IndexPage>;
  /** Does this source own the given node id? Routes `resolveNode`. */
  owns(nodeId: string): boolean;
  /** On-demand single-record fetch for an endpoint outside the indexed set. */
  resolve?(ctx: IndexSourceContext, nodeId: string): Promise<ProjectGraphNode | null>;
  /**
   * On-demand detail for a record the index ALREADY holds — a tracker body, a
   * document's text, a commit message. Bounded by the source.
   *
   * A source with no detail worth fetching omits this. Sessions deliberately
   * do: the only additional data behind a session is its transcript, and the
   * index never reads transcripts.
   */
  loadDetail?(ctx: IndexSourceContext, nodeId: string): Promise<NodeDetail | null>;
}

export interface NodeDetail {
  /** The record's text body, truncated by the source to a stated bound. */
  body?: string;
  /** True when `body` was cut short. */
  truncated?: boolean;
  /** Extra fields merged onto the record. */
  fields?: Record<string, unknown>;
}

export function resolveOptions(options: ProjectIndexOptions = {}): ResolvedIndexOptions {
  const sources = {} as Record<IndexSourceId, boolean>;
  for (const id of INDEX_SOURCE_IDS) sources[id] = options.sources?.[id] ?? true;
  return {
    sources,
    includeArchived: options.includeArchived ?? true,
    historyHorizonMs: options.historyHorizonMs ?? null,
    // All-history for metadata AND events by default. A default horizon would
    // state a bound the caller never set, which `coverage.window` then reports
    // back as fact; the cost is bounded at the walk instead (see the note in
    // `resolveEventWindows`). A caller wanting the 90-day retention passes it
    // explicitly via `DEFAULT_EVENT_HORIZON_DAYS`.
    eventScope: options.eventScope ?? { mode: 'all' },
    // No defaults merged in: an omitted source is unlimited.
    safetyMax: { ...options.safetyMax },
    pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    cache: options.cache ?? true,
  };
}

export function emptyCoverage(id: IndexSourceId, label: string, enabled: boolean): SourceCoverage {
  return {
    sourceId: id,
    label,
    enabled,
    availability: enabled ? 'available' : 'disabled',
    indexed: 0,
    total: null,
    complete: false,
    truncated: false,
    detailLoaded: 0,
    events: noEventsRetrieved(),
    eventHistoryComplete: false,
    window: null,
    pages: 0,
    lastIndexedAt: 0,
  };
}

/** The starting event state: metadata only, nothing about history retrieved. */
export function noEventsRetrieved(support: 'none' | 'window' = 'none'): SourceCoverage['events'] {
  return {
    support,
    retrieved: false,
    scope: 'none',
    window: null,
    complete: false,
    reason:
      support === 'none'
        ? 'This source indexes record metadata only; it cannot answer an event-history query.'
        : 'Event history has not been retrieved for this source yet.',
  };
}

/**
 * True when EVERY enabled source reports complete event history.
 *
 * The gate for a full period-over-period comparison. One source that only
 * indexed metadata is enough to make a "this week vs last week" figure a
 * statement about retrieval rather than about the project.
 */
export function eventHistoryCompleteForAll(
  coverage: Record<IndexSourceId, SourceCoverage>,
): boolean {
  const enabled = Object.values(coverage).filter(c => c.enabled && c.availability === 'available');
  return enabled.length > 0 && enabled.every(c => c.eventHistoryComplete);
}
