/**
 * The incremental project index.
 *
 * Retrieval only — no layout, no geometry, no filtering for display. See
 * `types.ts` for why this exists separately from the snapshot loader.
 *
 * Concurrency rules the shell can rely on:
 *
 *  - **One run at a time, latest wins.** Every load/refresh queues on a single
 *    chain, so two runs can never execute concurrently — the sources hold
 *    per-run accumulators and two runs would corrupt each other's. A caller
 *    that is superseded while still queued does not run at all.
 *  - **A superseded run cannot publish.** It stops at its next page boundary
 *    and every publish checks its generation, so a slow source finishing after
 *    a newer load cannot resurrect stale records. A superseded run also
 *    announces nothing: the user did not ask for it to stop.
 *  - **An explicitly cancelled run settles.** `cancel()` returns the state to
 *    `ready` (or `idle`) with `progress.phase: 'cancelled'`, rather than
 *    leaving a spinner that never clears.
 *  - **The previous snapshot survives the next load.** Once there is a
 *    committed state, `records` keeps it while a newer load runs; `status` goes
 *    `loading` and `progress` ticks. Only the very first load fills
 *    progressively, because there is nothing to preserve.
 *  - **Progress-only publishes reuse the same arrays.** `records`, `edges`,
 *    `unresolvedEdgeIds` and `generatedAt` keep their identity across ticks
 *    where the data did not change, so the shell does not recompute its view
 *    model once per page.
 *  - **Refresh reconciles removals** — and is a full re-enumeration of the
 *    named sources, not a delta. See {@link ProjectIndex.refresh}.
 */
import type { PanelHost } from '@nimbalyst/extension-sdk';
import type { ProjectGraphEdge, ProjectGraphNode } from '../types';
import {
  CancelledError,
  INDEX_SOURCE_IDS,
  emptyCoverage,
  noEventsRetrieved,
  resolveOptions,
  type CancelSignal,
  type IndexProgress,
  type IndexSource,
  type IndexSourceContext,
  type IndexSourceId,
  type ProjectIndexOptions,
  type ProjectIndexState,
  type ResolvedIndexOptions,
  type NodeDetail,
  type SourceCoverage,
  type SourceTiming,
} from './types';
import { PageScheduler, type PageSchedulerOptions } from './scheduler';
import { mergeCommitEvidence } from './commitEvidenceState';
import { resolveEventWindows } from './eventScope';
import { createSessionsSource } from './sources/sessionsSource';
import { createTrackersSource } from './sources/trackersSource';
import { createGitSource, loadCommitFileEvidence } from './sources/gitSource';
import { createGitHubSource } from './sources/githubSource';
import { createDocsSource, createMemorySource, createPlansSource } from './sources/fileSources';
import { cacheScopeOf, readCachedIndex, toCachedRecord, writeCachedIndex, type CachedSourceSlice } from './cache';
import { canonicalFileNodeId } from '../adapters/referenceIds';

/** One source's contribution, kept separate so a refresh can replace just it. */
interface SourceSlice {
  records: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  coverage: SourceCoverage;
  timing?: SourceTiming;
}

export interface ProjectIndexDeps {
  /** Override the source set. Tests supply fakes; production uses the default. */
  sources?: IndexSource[];
  scheduler?: PageSchedulerOptions;
}

export class ProjectIndex {
  readonly #host: PanelHost;
  #options: ResolvedIndexOptions;
  readonly #sources: IndexSource[];
  readonly #schedulerOptions: PageSchedulerOptions;

  #slices = new Map<IndexSourceId, SourceSlice>();
  #state: ProjectIndexState;
  #listeners = new Set<(state: ProjectIndexState) => void>();

  #generation = 0;
  #cancelled = false;
  /** Set by `cancel()` only. A supersede is not a cancellation to the user. */
  #cancelRequested = false;
  #disposed = false;

  // Run queue. Every load/refresh takes a ticket and waits its turn on a single
  // chain, so two runs can never execute concurrently — the sources hold
  // per-run accumulators (edited-file counts, enumerated paths, relationship
  // schemas) and two runs mutating them at once corrupts both. A ticket that is
  // no longer the newest when its turn arrives does not run at all: with three
  // callers queued, the middle one is pure waste.
  #chain: Promise<unknown> = Promise.resolve();
  #ticketSeq = 0;
  #latestTicket = 0;

  // Memoized composition. Progress-only publishes must hand back the SAME
  // record/edge arrays, or the shell recomputes its whole view model on every
  // page for data that did not change.
  //
  // Versions are per MAP, not global: during a load the staging map changes on
  // every page while the committed map does not, and a single counter would
  // invalidate the committed composition on every staging write — which is the
  // exact recomputation this exists to prevent.
  #mapVersions = new WeakMap<Map<IndexSourceId, SourceSlice>, number>();
  #composed: {
    version: number;
    slices: Map<IndexSourceId, SourceSlice>;
    records: ProjectGraphNode[];
    edges: ProjectGraphEdge[];
    unresolvedEdgeIds: string[];
    generatedAt: number;
  } | null = null;
  /** True once a load has committed, which switches off progressive publish. */
  #hasCommitted = false;
  /** True while the committed state came from the cache rather than a load. */
  #fromCache = false;
  /** Per-node detail cache. Cleared whenever a load re-enumerates its source. */
  #details = new Map<string, NodeDetail>();

  constructor(host: PanelHost, options: ProjectIndexOptions = {}, deps: ProjectIndexDeps = {}) {
    this.#host = host;
    this.#options = resolveOptions(options);
    this.#schedulerOptions = deps.scheduler ?? {};
    this.#sources = deps.sources ?? defaultSources();
    this.#state = this.#composeState('idle', idleProgress());
  }

  getState(): ProjectIndexState {
    return this.#state;
  }

  subscribe(listener: (state: ProjectIndexState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Read a previously persisted index into memory without touching any source.
   *
   * Returns false when there is no usable cache. A cache hit is still marked
   * with each source's recorded `lastIndexedAt`, so a consumer can see how
   * stale it is rather than assuming it is current.
   */
  async hydrateFromCache(): Promise<boolean> {
    if (!this.#options.cache) return false;
    const cached = await readCachedIndex(this.#host, cacheScopeOf(this.#options));
    if (!cached) return false;
    for (const [id, slice] of Object.entries(cached.sources) as Array<[IndexSourceId, CachedSourceSlice]>) {
      // A source switched off since the cache was written contributes nothing,
      // even though the scope check above should already have rejected it.
      if (this.#options.sources[id] === false) continue;
      this.#slices.set(id, { records: slice.records, edges: slice.edges, coverage: slice.coverage });
      this.#touchSlices();
    }
    this.#hasCommitted = this.#slices.size > 0;
    this.#fromCache = this.#hasCommitted;
    this.#publish(this.#composeState('ready', idleProgress()));
    return this.#hasCommitted;
  }

  /**
   * Index every enabled source. Supersedes any load already running.
   *
   * Sources run one at a time. They contend for the same single-threaded
   * database worker, so running them concurrently would not shorten the wall
   * clock — it would just make each page slower and delay the foreground.
   */
  load(options?: Partial<ProjectIndexOptions>): Promise<ProjectIndexState> {
    if (options) this.#options = resolveOptions({ ...this.#options, ...options });
    return this.#run(INDEX_SOURCE_IDS.slice(), { reset: true });
  }

  /**
   * Re-index a subset of sources, reconciling removals within those sources.
   * Untouched sources keep both their records and their coverage.
   *
   * **This is a full re-enumeration of each named source, not a delta.** None
   * of these backends offers a change feed: there is no "rows since" cursor on
   * the tracker or session tables, `git log` has no incremental mode that
   * respects a keyset, and the REST endpoints page from the top. "Incremental"
   * describes the PAGING — the index yields between pages and preserves the
   * previous snapshot while running — not the update.
   *
   * The practical consequence for the shell: refreshing one source costs what
   * indexing it costs, and `coverage[id].lastIndexedAt` is a true "as of" for
   * the whole source rather than the age of its oldest stale record.
   */
  refresh(opts: { sources?: IndexSourceId[] } = {}): Promise<ProjectIndexState> {
    return this.#run(opts.sources ?? INDEX_SOURCE_IDS.slice(), { reset: false });
  }

  /**
   * Fetch one record that a relation points at but the index does not hold.
   *
   * This is the affordance behind an unresolved endpoint: the relation was
   * recorded, so the record exists somewhere, and the user can ask for it
   * rather than being told nothing is there.
   *
   * For a record the index already holds, this returns it as-is. To fetch that
   * record's body or other detail, use {@link loadDetail}.
   */
  async resolveNode(id: string): Promise<ProjectGraphNode | null> {
    const existing = this.#state.records.find(r => r.id === id);
    if (existing) return existing;

    // A session's `linkedTrackerItemIds` carries `file:` references. No source
    // owns a `file:` id, so without this mapping the affordance behind an
    // unresolved endpoint silently did nothing for every one of them.
    const canonical = canonicalFileNodeId(id, { workspacePath: this.#host.workspacePath });
    if (canonical) {
      const already = this.#state.records.find(r => r.id === canonical);
      if (already) return already;
      return this.resolveNode(canonical);
    }

    const source = this.#sources.find(s => s.owns(id) && this.#options.sources[s.id]);
    if (!source?.resolve) return null;

    const signal = this.#readSignal();
    const ctx = this.#context(signal);
    let node: ProjectGraphNode | null = null;
    try {
      node = await source.resolve(ctx, id);
    } catch {
      return null;
    }
    if (!node || signal.cancelled) return null;

    const slice = this.#slices.get(source.id);
    if (slice && !slice.records.some(r => r.id === node!.id)) {
      slice.records = [...slice.records, node];
      // `detailLoaded` counts records fetched outside the paged pass; it is
      // deliberately not folded into `indexed`, which describes the enumeration.
      slice.coverage = { ...slice.coverage, detailLoaded: slice.coverage.detailLoaded + 1 };
      this.#touchSlices();
      this.#publish(this.#composeState(this.#state.status, this.#state.progress));
    }
    return node;
  }

  /** Fetch on-demand source detail; stale reads return no data to the caller. */
  async loadDetail(id: string): Promise<NodeDetail | null> {
    const cached = this.#details.get(id);
    if (cached) return cached;

    const source = this.#sources.find(s => s.owns(id));
    if (!source?.loadDetail || this.#options.sources[source.id] === false) return null;

    const slice = this.#slices.get(source.id);
    if (!slice?.records.some(r => r.id === id)) return null;

    const signal = this.#readSignal();
    let detail: NodeDetail | null = null;
    try {
      detail = await source.loadDetail(this.#context(signal), id);
    } catch {
      return null;
    }
    if (!detail || signal.cancelled) return null;

    const current = this.#slices.get(source.id);
    const index = current?.records.findIndex(r => r.id === id) ?? -1;
    if (!current || index < 0 || !this.#options.sources[source.id]) return null;

    this.#details.set(id, detail);
    const records = current.records.slice();
    const record = records[index]!;
    records[index] = {
      ...record,
      fields: {
        ...record.fields,
        ...detail.fields,
        ...(detail.body !== undefined ? { body: detail.body, bodyTruncated: detail.truncated ?? false } : {}),
        detailLoadedAt: Date.now(),
      },
    };
    this.#slices.set(source.id, {
      ...current,
      records,
      coverage: { ...current.coverage, detailLoaded: current.coverage.detailLoaded + 1 },
    });
    this.#touchSlices();
    this.#publish(this.#composeState(this.#state.status, this.#state.progress));
    return detail;
  }

  /** Fetch paged commit evidence for specific commits or a requested window. */
  async loadCommitEvidence(
    request: {
      shas?: readonly string[];
      sinceMs?: number | null;
      untilMs?: number | null;
      maxCommits?: number;
      /**
       * Take the window from the configured event scope instead of explicit
       * bounds. `preceding` is the equal-elapsed comparison period, so a
       * week-over-week figure is not a partial week against a full one.
       */
      scope?: 'current' | 'preceding';
    },
  ): Promise<{ covered: number; truncated: boolean; error?: string }> {
    let slice = this.#slices.get('git');
    if (!slice || !this.#options.sources.git) return { covered: 0, truncated: false, error: 'The git source is not loaded.' };

    let resolved = request;
    let retrievedWindow: { startMs: number; endMs: number } | null = null;
    if (request.scope) {
      const scope = resolveEventWindows(this.#options, { nowMs: Date.now() });
      const window = request.scope === 'preceding' ? scope.preceding : scope.current;
      if (!window) {
        // All-history mode has no window to take. Saying so beats silently
        // falling back to an unbounded walk the caller did not ask for.
        return { covered: 0, truncated: false, error: `No ${request.scope} window is configured; event scope is all history.` };
      }
      resolved = { ...request, sinceMs: window.startMs, untilMs: window.endMs };
      retrievedWindow = { startMs: window.startMs, endMs: window.endMs };
    } else if (request.sinceMs != null || request.untilMs != null) {
      retrievedWindow = {
        startMs: request.sinceMs ?? Number.NEGATIVE_INFINITY,
        endMs: request.untilMs ?? Date.now(),
      };
    }

    const signal = this.#readSignal();
    let evidence: Awaited<ReturnType<typeof loadCommitFileEvidence>>;
    try { evidence = await loadCommitFileEvidence(this.#host, signal, resolved); }
    catch (error) {
      if (signal.cancelled) return { covered: 0, truncated: false };
      throw error;
    }
    if (signal.cancelled) return { covered: 0, truncated: false };
    // Another detail lookup may have finished while this one was reading.
    slice = this.#slices.get('git')!;

    this.#slices.set('git', mergeCommitEvidence(slice, evidence, retrievedWindow, !!request.shas?.length));
    this.#touchSlices();
    this.#publish(this.#composeState(this.#state.status, this.#state.progress));
    return { covered: evidence.covered.length, truncated: evidence.truncated, error: evidence.error };
  }

  /**
   * Stop the in-flight load at the user's request.
   *
   * The committed state is left untouched, and the run settles to `ready` (or
   * `idle` if nothing was ever committed) with `progress.phase: 'cancelled'`.
   */
  cancel(): void {
    this.#cancelled = true;
    this.#cancelRequested = true;
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancelled = true;
    this.#listeners.clear();
  }

  // -------------------------------------------------------------------------

  #run(sourceIds: IndexSourceId[], opts: { reset: boolean }): Promise<ProjectIndexState> {
    const ticket = ++this.#ticketSeq;
    this.#latestTicket = ticket;
    // Ask whatever is running to stop at its next page boundary. A supersede,
    // not a user cancellation.
    this.#cancelled = true;

    const run = this.#chain.then(async () => {
      // Superseded while queued: a newer caller is behind us and will run
      // instead. Doing the work anyway would be pure waste and would race the
      // newer run for the same source objects.
      if (ticket !== this.#latestTicket || this.#disposed) return this.#state;
      this.#cancelled = false;
      this.#cancelRequested = false;
      const generation = ++this.#generation;
      return this.#execute(generation, sourceIds, opts);
    });
    // The chain must never reject, or one failed run would wedge every load
    // queued behind it.
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #execute(
    generation: number,
    sourceIds: IndexSourceId[],
    opts: { reset: boolean },
  ): Promise<ProjectIndexState> {
    const signal = this.#signal(generation);
    // Ordered by INDEX_SOURCE_IDS, not by however the source array was
    // assembled: that order is what puts cheap local metadata on screen before
    // a network round trip (see the constant's header).
    const active = this.#sources
      .filter(s => sourceIds.includes(s.id))
      .sort((a, b) => INDEX_SOURCE_IDS.indexOf(a.id) - INDEX_SOURCE_IDS.indexOf(b.id));
    const progress: IndexProgress = {
      phase: 'counting',
      completedSources: 0,
      totalSources: active.length,
      recordsIndexed: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Staged, not committed. The previously loaded snapshot stays in `#slices`
    // and therefore stays on screen until this run finishes; clearing it up
    // front is what turns a refresh into a blank pane. A full load starts from
    // an empty stage so a source that is now disabled cannot survive into the
    // new state; a partial refresh starts from the committed slices so
    // untouched sources are carried over unchanged.
    const staging = new Map(opts.reset ? [] : this.#slices);
    // A COPY, always. `progress` is mutated in place as the run advances, so
    // publishing the live object would rewrite the progress of every state a
    // subscriber is still holding.
    this.#publishIf(signal, generation, this.#composeState('loading', { ...progress }));

    try {
      for (const source of active) {
        signal.throwIfCancelled();
        progress.activeSourceId = source.id;
        progress.phase = 'counting';
        this.#publishIf(signal, generation, this.#composeState('loading', { ...progress, updatedAt: Date.now() }));

        const slice = await this.#indexSource(source, signal, generation, progress, staging);
        staging.set(source.id, slice);
        this.#touchSlices(staging);
        progress.completedSources += 1;
        progress.phase = 'indexing';
        this.#publishIf(signal, generation, this.#composeState('loading', { ...progress, updatedAt: Date.now() }));
      }

      signal.throwIfCancelled();
      this.#slices = staging;
      this.#touchSlices();
      this.#hasCommitted = true;
      this.#fromCache = false;
      const done: IndexProgress = { ...progress, phase: 'done', activeSourceId: undefined, updatedAt: Date.now() };
      const state = this.#composeState('ready', done);
      this.#publishIf(signal, generation, state);
      if (this.#options.cache) await this.#writeCache(generation);
      return state;
    } catch (err) {
      if (err instanceof CancelledError) {
        // Nothing is committed either way. But the two reasons for stopping
        // are different to the user: they asked, or a newer load took over.
        if (this.#cancelRequested && this.#generation === generation && !this.#disposed) {
          // They asked. Publishing nothing leaves a spinner that never clears,
          // which is a worse outcome than the load they cancelled. Settle back
          // onto whatever was last committed.
          this.#cancelRequested = false;
          const settled = this.#composeState(this.#hasCommitted ? 'ready' : 'idle', {
            ...progress,
            phase: 'cancelled',
            activeSourceId: undefined,
            updatedAt: Date.now(),
          });
          this.#publish(settled);
          return settled;
        }
        // Superseded. The user did not ask to stop, so nothing announces a
        // cancellation to them; the newer run owns the next publish.
        return this.#state;
      }
      this.#slices = staging;
      this.#touchSlices();
      const state = this.#composeState('error', {
        ...progress,
        phase: 'error',
        updatedAt: Date.now(),
      });
      const errored: ProjectIndexState = { ...state, error: String(err).slice(0, 300) };
      this.#publishIf(signal, generation, errored);
      return errored;
    }
  }

  async #indexSource(
    source: IndexSource,
    signal: CancelSignal,
    generation: number,
    progress: IndexProgress,
    staging: Map<IndexSourceId, SourceSlice>,
  ): Promise<SourceSlice> {
    const enabled = this.#options.sources[source.id] !== false;
    const coverage = emptyCoverage(source.id, source.label, enabled);
    if (!enabled) {
      return { records: [], edges: [], coverage: { ...coverage, availability: 'disabled', complete: false } };
    }

    const ctx = this.#context(signal);
    let prepared;
    const prepareStarted = Date.now();
    try {
      prepared = await source.prepare(ctx);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      return {
        records: [],
        edges: [],
        timing: timingOf(prepareStarted, null),
        coverage: { ...coverage, availability: 'error', message: String(err).slice(0, 200), lastIndexedAt: Date.now() },
      };
    }
    const prepareMs = Date.now() - prepareStarted;

    if (prepared.availability !== 'available') {
      return {
        records: [],
        edges: [],
        // Recorded even though nothing paged: a slow availability probe is a
        // real cost, and omitting it hides where a slow load went.
        timing: { prepareMs, totalMs: 0, pages: 0, slowestPageMs: 0, averagePageMs: 0 },
        coverage: {
          ...coverage,
          availability: prepared.availability,
          message: prepared.message,
          total: prepared.total,
          // Nothing was read, so nothing about the scope is known to be covered
          // — even when the total is a confident zero.
          complete: prepared.availability === 'unavailable' && prepared.total === 0,
          window: prepared.window ?? null,
          events: noEventsRetrieved(prepared.eventSupport ?? 'none'),
          eventHistoryComplete: false,
          scopeDescription: prepared.scope,
          lastIndexedAt: Date.now(),
        },
      };
    }

    // A source is about to be re-enumerated, so any detail cached against its
    // previous records is about to describe records that no longer exist.
    for (const [nodeId] of this.#details) {
      if (source.owns(nodeId)) this.#details.delete(nodeId);
    }

    const scheduler = new PageScheduler({ initialPageSize: this.#options.pageSize, ...this.#schedulerOptions });
    // No built-in ceiling: an omitted safetyMax means unlimited.
    const safetyMax = this.#options.safetyMax[source.id] ?? Number.POSITIVE_INFINITY;
    const byId = new Map<string, ProjectGraphNode>();
    const edgeById = new Map<string, ProjectGraphEdge>();
    let cursor: string | undefined;
    let pages = 0;
    let owned = 0;
    let truncated = false;
    let truncationReason: string | undefined;
    let error: string | undefined;
    // Set only when the source stopped handing over pages of its own accord.
    // Breaking out on a ceiling or an error leaves this false.
    let exhausted = false;
    // A source can also truncate while ENUMERATING, before any page runs — a
    // filesystem walk that hit its ceiling while listing. Seeding from prepare
    // is what stops a capped enumeration reading as complete.
    if (prepared.truncated) {
      truncated = true;
      truncationReason = prepared.truncationReason;
    }

    progress.phase = 'indexing';
    do {
      signal.throwIfCancelled();
      const started = Date.now();
      let page;
      try {
        page = await source.page(ctx, cursor, scheduler.pageSize);
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        // A source that fails partway keeps the pages it did read. Discarding
        // them would turn a partial answer into a blank one, and coverage
        // already says the result is incomplete.
        error = String(err).slice(0, 200);
        break;
      }
      // A page that resolved after this run was superseded is thrown away here
      // rather than merged: without this check the superseded run would go on
      // to publish, since the generation has not been bumped yet while the
      // newer load is still awaiting this one's settlement.
      signal.throwIfCancelled();
      scheduler.record(Date.now() - started);
      pages += 1;

      // Later pages supersede earlier ones by id: the rolling directory
      // aggregates are re-emitted with their running totals.
      for (const record of page.records) byId.set(record.id, record);
      for (const edge of page.edges) edgeById.set(edge.id, edge);

      // `indexed` counts only the records this source is the authority for.
      // The sessions source also emits directory rollups; counting those
      // against a session total would report 8,000 of 6,253 and read as
      // complete for the wrong reason.
      owned = countOwned(source, byId);
      progress.recordsIndexed += page.records.length;
      progress.updatedAt = Date.now();
      if (!this.#hasCommitted) {
        // First load only: fill the view as it arrives, since there is no
        // previous answer to preserve. Once a snapshot exists, publishing
        // partials would replace a complete answer with a subset of itself.
        staging.set(source.id, {
          records: Array.from(byId.values()),
          edges: Array.from(edgeById.values()),
          coverage: { ...coverage, indexed: owned, total: prepared.total, pages },
        });
        this.#touchSlices(staging);
        this.#publishIf(signal, generation, this.#composeState('loading', { ...progress }, staging));
      }

      // Only a stop with work still pending is a truncation. A corpus that
      // happens to be exactly the size of its ceiling is complete, and calling
      // it truncated would report a false gap.
      if (owned >= safetyMax && page.cursor) {
        truncated = true;
        truncationReason =
          `Stopped at the ${safetyMax.toLocaleString()} record safety maximum for ${source.label}` +
          (prepared.total != null ? ` (${prepared.total.toLocaleString()} exist).` : '.');
        break;
      }

      cursor = page.cursor;
      if (!cursor) exhausted = true;
      if (cursor) await scheduler.yield();
    } while (cursor);

    const indexed = countOwned(source, byId);
    const authoritative = (prepared.enumeration ?? 'authoritative') === 'authoritative';
    return {
      records: Array.from(byId.values()),
      edges: Array.from(edgeById.values()),
      timing: { prepareMs, ...scheduler.timing },
      coverage: {
        ...coverage,
        availability: error ? 'error' : 'available',
        message: error ?? prepared.message,
        indexed,
        total: prepared.total,
        // Exhausting an authoritative enumeration IS the proof of completeness;
        // a count, where one exists, is a second check that the two agree. A
        // missing count is not evidence of a gap.
        complete:
          exhausted &&
          authoritative &&
          !truncated &&
          !error &&
          (prepared.total == null || indexed >= prepared.total),
        truncated,
        truncationReason,
        // ONLY what this source actually retrieved. Falling back to the run's
        // requested scope labelled documents, memory and plain header sources
        // with "retrieved Jun 7 - Sep 5" purely because that window had been
        // asked for — a requested bound is not a retrieval.
        window: prepared.window ?? null,
        events: noEventsRetrieved(prepared.eventSupport ?? 'none'),
        eventHistoryComplete: false,
        scopeDescription: prepared.scope,
        pages,
        lastIndexedAt: Date.now(),
      },
    };
  }

  async #writeCache(generation: number): Promise<void> {
    if (this.#generation !== generation) return;
    const slices: Record<string, CachedSourceSlice> = {};
    for (const [id, slice] of this.#slices) {
      // Lite projection only — see `toCachedRecord`. Caching whole records put
      // every real corpus over the size ceiling, so nothing was ever cached.
      slices[id] = {
        records: slice.records.map(toCachedRecord),
        edges: slice.edges,
        coverage: slice.coverage,
      };
    }
    await writeCachedIndex(this.#host, {
      version: 1,
      generatedAt: Date.now(),
      scope: cacheScopeOf(this.#options),
      sources: slices,
    });
  }

  #context(signal: CancelSignal): IndexSourceContext {
    return {
      host: this.#host,
      options: this.#options,
      eventScope: resolveEventWindows(this.#options, { nowMs: Date.now() }),
      signal,
    };
  }

  #readSignal(): CancelSignal {
    const generation = this.#generation;
    const ticket = this.#latestTicket;
    const cancelled = () => this.#disposed || this.#cancelled || this.#generation !== generation || this.#latestTicket !== ticket;
    return {
      get cancelled() { return cancelled(); },
      throwIfCancelled() { if (cancelled()) throw new CancelledError(); },
    };
  }

  #signal(generation: number): CancelSignal {
    const isCancelled = () => this.#disposed || this.#cancelled || this.#generation !== generation;
    return {
      get cancelled() {
        return isCancelled();
      },
      throwIfCancelled: () => {
        if (isCancelled()) throw new CancelledError();
      },
    };
  }

  #composeState(
    status: ProjectIndexState['status'],
    progress: IndexProgress,
    slices: Map<IndexSourceId, SourceSlice> = this.#slices,
  ): ProjectIndexState {
    const coverage = {} as Record<IndexSourceId, SourceCoverage>;
    const timings: Partial<Record<IndexSourceId, SourceTiming>> = {};
    for (const source of this.#sources) {
      const slice = slices.get(source.id);
      coverage[source.id] =
        slice?.coverage ?? emptyCoverage(source.id, source.label, this.#options.sources[source.id] !== false);
      if (slice?.timing) timings[source.id] = slice.timing;
    }

    // Coverage and progress are small and are rebuilt every publish. The record
    // and edge arrays are not: a progress tick that hands the shell fresh
    // arrays forces it to recompute its whole view model for data that did not
    // change, once per page.
    const composed = this.#composeRecords(slices);

    return {
      status,
      generation: this.#generation,
      records: composed.records,
      edges: composed.edges,
      unresolvedEdgeIds: composed.unresolvedEdgeIds,
      coverage,
      progress,
      timings,
      fromCache: this.#fromCache,
      generatedAt: composed.generatedAt,
    };
  }

  #composeRecords(slices: Map<IndexSourceId, SourceSlice>) {
    const version = this.#mapVersions.get(slices) ?? 0;
    const cached = this.#composed;
    if (cached && cached.slices === slices && cached.version === version) return cached;

    const records: ProjectGraphNode[] = [];
    const byId = new Set<string>();
    const edges: ProjectGraphEdge[] = [];
    const edgeIds = new Set<string>();

    for (const source of this.#sources) {
      const slice = slices.get(source.id);
      if (!slice) continue;
      // First writer wins for a node id, matching the snapshot loader, so a
      // directory seen by two sources keeps one identity.
      for (const record of slice.records) {
        if (byId.has(record.id)) continue;
        byId.add(record.id);
        records.push(record);
      }
      for (const edge of slice.edges) {
        if (edgeIds.has(edge.id)) continue;
        edgeIds.add(edge.id);
        edges.push(edge);
      }
    }

    const composed = {
      version,
      slices,
      records,
      edges,
      unresolvedEdgeIds: edges.filter(e => !byId.has(e.sourceId) || !byId.has(e.targetId)).map(e => e.id),
      generatedAt: Date.now(),
    };
    this.#composed = composed;
    return composed;
  }

  /** Every mutation of a slice map goes through here so the memo cannot go stale. */
  #touchSlices(slices: Map<IndexSourceId, SourceSlice> = this.#slices): void {
    this.#mapVersions.set(slices, (this.#mapVersions.get(slices) ?? 0) + 1);
  }

  #publishIf(signal: CancelSignal, generation: number, state: ProjectIndexState): void {
    if (signal.cancelled || this.#generation !== generation || this.#disposed) return;
    this.#publish(state);
  }

  #publish(state: ProjectIndexState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }
}

export function defaultSources(): IndexSource[] {
  return [
    createSessionsSource(),
    createTrackersSource(),
    createGitSource(),
    createPlansSource(),
    createDocsSource(),
    createGitHubSource(),
    createMemorySource(),
  ];
}

function timingOf(startedMs: number, pageTiming: { totalMs: number; pages: number; slowestPageMs: number } | null): SourceTiming {
  const pages = pageTiming?.pages ?? 0;
  const totalMs = pageTiming?.totalMs ?? 0;
  return {
    prepareMs: Date.now() - startedMs,
    totalMs,
    pages,
    slowestPageMs: pageTiming?.slowestPageMs ?? 0,
    averagePageMs: pages > 0 ? Math.round(totalMs / pages) : 0,
  };
}

/** How many indexed records this source is the authority for. */
function countOwned(source: IndexSource, byId: Map<string, ProjectGraphNode>): number {
  let n = 0;
  for (const id of byId.keys()) {
    if (source.owns(id)) n += 1;
  }
  return n;
}

function idleProgress(): IndexProgress {
  return {
    phase: 'idle',
    completedSources: 0,
    totalSources: 0,
    recordsIndexed: 0,
    startedAt: 0,
    updatedAt: 0,
  };
}


export type {
  IndexSourceId,
  ProjectIndexOptions,
  ProjectIndexState,
  SourceCoverage,
  IndexProgress,
} from './types';
