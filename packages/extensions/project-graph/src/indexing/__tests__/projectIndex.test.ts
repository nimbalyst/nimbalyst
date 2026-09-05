// @vitest-environment node

/**
 * Index mechanics, exercised against fake sources.
 *
 */
import { describe, expect, it, vi } from 'vitest';
import { ProjectIndex } from '../projectIndex';
import {
  eventHistoryCompleteForAll,
  resolveOptions,
  type IndexPage,
  type IndexSource,
  type ProjectIndexState,
} from '../types';
import { createTestHost } from '../../adapters/__tests__/testHost';
import type { ProjectGraphEdge, ProjectGraphNode } from '../../types';

function record(id: string): ProjectGraphNode {
  return {
    id,
    type: 'task',
    label: id,
    category: 'delivery',
    source: 'tracker',
    visibility: 'local',
  };
}

interface FakeSourceOptions {
  id?: IndexSource['id'];
  prefix?: string;
  ids?: string[];
  total?: number | null;
  edges?: ProjectGraphEdge[];
  availability?: 'available' | 'unavailable' | 'error';
  message?: string;
  /** Throw on the page with this 0-based number. */
  failOnPage?: number;
  /** Awaited before each page resolves; lets a test hold a load open. */
  gate?: () => Promise<void>;
  onPrepare?: () => void;
}

function fakeSource(options: FakeSourceOptions = {}): IndexSource {
  const prefix = options.prefix ?? 'tracker:';
  const ids = options.ids ?? [];
  let pageNumber = 0;
  return {
    id: options.id ?? 'trackers',
    label: options.id ?? 'trackers',
    async prepare() {
      options.onPrepare?.();
      pageNumber = 0;
      return {
        availability: options.availability ?? 'available',
        message: options.message,
        total: options.total === undefined ? ids.length : options.total,
      };
    },
    async page(_ctx, cursor, pageSize): Promise<IndexPage> {
      if (options.gate) await options.gate();
      const current = pageNumber++;
      if (options.failOnPage === current) throw new Error('source blew up');
      const start = cursor ? Number(cursor) : 0;
      const slice = ids.slice(start, start + pageSize);
      const next = start + slice.length;
      return {
        records: slice.map(id => record(`${prefix}${id}`)),
        edges: current === 0 ? (options.edges ?? []) : [],
        cursor: next < ids.length ? String(next) : undefined,
        rows: slice.length,
      };
    },
    owns(nodeId) {
      return nodeId.startsWith(prefix);
    },
    async resolve(_ctx, nodeId) {
      return record(nodeId);
    },
  };
}

function makeIndex(sources: IndexSource[], options = {}) {
  const { host, storage } = createTestHost();
  const index = new ProjectIndex(host, { cache: false, pageSize: 100, ...options }, {
    sources,
    // No inter-page delay and no adaptive resizing: these tests assert paging
    // and ordering, and a page size that grows with measured speed would make
    // the page count depend on how fast the machine happens to be. Adaptive
    // sizing has its own test in scheduler.test.ts.
    scheduler: { interPageDelayMs: 0, fastMs: -1, slowMs: Number.POSITIVE_INFINITY },
  });
  return { index, host, storage };
}

const ids = (n: number, prefix = 'i') => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);

describe('paging and coverage arithmetic', () => {
  it('pages the whole corpus and only then claims completeness', async () => {
    const { index } = makeIndex([fakeSource({ ids: ids(250) })]);

    const state = await index.load();

    expect(state.records).toHaveLength(250);
    expect(state.coverage.trackers.pages).toBe(3);
    expect(state.coverage.trackers.indexed).toBe(250);
    expect(state.coverage.trackers.complete).toBe(true);
  });

  it('is complete when an authoritative enumeration ran to exhaustion, even with no count', async () => {
    const { index } = makeIndex([fakeSource({ ids: ids(10), total: null })]);

    const { coverage } = await index.load();

    // Git across all refs and a filesystem walk have no cheap COUNT, but paging
    // them to exhaustion IS the authoritative answer. Requiring a denominator
    // would report every such source as permanently incomplete.
    expect(coverage.trackers.indexed).toBe(10);
    expect(coverage.trackers.total).toBeNull();
    expect(coverage.trackers.complete).toBe(true);
  });

  it('is incomplete when enumeration stopped early, whatever the count says', async () => {
    const truncating = makeIndex([fakeSource({ id: 'trackers', ids: ids(500), total: null })], {
      safetyMax: { trackers: 150 },
    });
    const failing = makeIndex([fakeSource({ id: 'docs', prefix: 'doc:', ids: ids(300), failOnPage: 1 })]);

    const stopped = (await truncating.index.load()).coverage.trackers;
    const errored = (await failing.index.load()).coverage.docs;

    // Exhaustion is the signal. A run that hit a ceiling or died partway did
    // not exhaust anything, so it cannot be complete.
    expect(stopped.complete).toBe(false);
    expect(errored.complete).toBe(false);
  });

  it('is incomplete when a count exists and the enumeration fell short of it', async () => {
    // The source claims 40 records but only yields 10 — the two disagree, and
    // the disagreement itself is evidence something was missed.
    const { index } = makeIndex([fakeSource({ ids: ids(10), total: 40 })]);

    expect((await index.load()).coverage.trackers.complete).toBe(false);
  });

  it('never claims completeness for a source that declares its paging bounded', async () => {
    const source = fakeSource({ ids: ids(5), total: null });
    source.prepare = async () => ({ availability: 'available', total: null, enumeration: 'bounded' });
    const { index } = makeIndex([source]);

    const { coverage } = await index.load();

    // A source whose pagination cannot promise it saw everything opts out, and
    // exhausting its pages proves only that it stopped handing them over.
    expect(coverage.trackers.indexed).toBe(5);
    expect(coverage.trackers.complete).toBe(false);
  });

  it('reports a safety maximum instead of silently shortening the answer', async () => {
    const { index } = makeIndex([fakeSource({ ids: ids(500) })], {
      safetyMax: { trackers: 150 },
    });

    const { coverage } = await index.load();

    expect(coverage.trackers.truncated).toBe(true);
    expect(coverage.trackers.complete).toBe(false);
    expect(coverage.trackers.truncationReason).toMatch(/150/);
    expect(coverage.trackers.truncationReason).toMatch(/500/);
  });

  it('counts only the records a source is the authority for', async () => {
    // A source that also emits rollup nodes it does not own (the sessions
    // source emits directories) must not count them against its total.
    const source = fakeSource({ ids: ids(3) });
    const original = source.page.bind(source);
    source.page = async (ctx, cursor, size) => {
      const page = await original(ctx, cursor, size);
      return { ...page, records: [...page.records, record('dir:packages/electron')] };
    };
    const { index } = makeIndex([source]);

    const state = await index.load();

    expect(state.coverage.trackers.indexed).toBe(3);
    expect(state.coverage.trackers.complete).toBe(true);
    expect(state.records).toHaveLength(4);
  });
});

describe('metadata completeness is separate from event history', () => {
  it('reports full metadata alongside unretrieved event history', async () => {
    const { index } = makeIndex([fakeSource({ ids: ids(10) })]);

    const { coverage } = await index.load();

    // Having every record does not mean having every record's history. A
    // source that indexes headers only must not let `complete: true` be read
    // as "all events are here".
    expect(coverage.trackers.complete).toBe(true);
    expect(coverage.trackers.events.retrieved).toBe(false);
    expect(coverage.trackers.events.scope).toBe('none');
    expect(coverage.trackers.events.complete).toBe(false);
    expect(coverage.trackers.events.reason).toBeTruthy();
  });

  it('marks git event history windowed once evidence is fetched for a window', async () => {
    const sha = 'a'.repeat(40);
    const { host } = createTestHost({
      workspacePath: '/ws',
      execs: [
        { match: /rev-parse/, handle: () => ({ stdout: 'true\n' }) },
        { match: /rev-list --count/, handle: () => ({ stdout: '1\n' }) },
        { match: /--name-only/, handle: () => ({ stdout: `__COMMIT__${sha}\ndocs/x.md\n` }) },
        { match: /git log/, handle: () => ({ stdout: `__COMMIT__${sha}\x1Fs\x1Fme\x1F2026-01-01T00:00:00Z` }) },
      ],
    });
    const now = Date.now();
    const index = new ProjectIndex(
      host,
      { cache: false, eventScope: { mode: 'window', window: { startMs: now - 86_400_000, endMs: now } } },
      { scheduler: { interPageDelayMs: 0 } },
    );
    await index.load();

    expect(index.getState().coverage.git.events.retrieved).toBe(false);

    await index.loadCommitEvidence({ scope: 'current' });
    const events = index.getState().coverage.git.events;

    expect(events.retrieved).toBe(true);
    expect(events.scope).toBe('windowed');
    expect(events.window).toEqual({ startMs: now - 86_400_000, endMs: now });
    // Evidence for one window is not evidence for all history.
    expect(events.complete).toBe(false);
  });
});

describe('retrieved event bounds are never the requested ones', () => {
  it('leaves window null for a source that retrieved no events, whatever was asked for', async () => {
    const now = Date.now();
    const { index } = makeIndex(
      [
        fakeSource({ id: 'docs', prefix: 'doc:', ids: ids(3, 'd') }),
        fakeSource({ id: 'memory', prefix: 'memory:', ids: ids(2, 'm') }),
      ],
      { eventScope: { mode: 'window', window: { startMs: now - 90 * 86_400_000, endMs: now } } },
    );

    const { coverage } = await index.load();

    for (const id of ['docs', 'memory'] as const) {
      // Requesting a window is not retrieving one. Labelling these
      // "retrieved Jun 7 - Sep 5" because that range was asked for is a
      // provenance claim neither source can support.
      expect(coverage[id].window).toBeNull();
      expect(coverage[id].events.retrieved).toBe(false);
      expect(coverage[id].events.window).toBeNull();
      expect(coverage[id].eventHistoryComplete).toBe(false);
      // "cannot answer an event query" is a different fact from "asked and
      // found none", and the UI has to be able to say which.
      expect(coverage[id].events.support).toBe('none');
      // Observed record counts are unaffected by any of this.
      expect(coverage[id].indexed).toBeGreaterThan(0);
    }
  });

  it('gates a full comparison on every enabled source, not just the one with events', async () => {
    const { index } = makeIndex([
      fakeSource({ id: 'docs', prefix: 'doc:', ids: ids(2, 'd') }),
      fakeSource({ id: 'git', prefix: 'commit:', ids: ids(2, 'c') }),
    ]);
    const { coverage } = await index.load();

    // One source that only indexed metadata is enough to make a period-over-
    // period figure a statement about retrieval rather than about the project.
    expect(eventHistoryCompleteForAll(coverage)).toBe(false);

    const all = { ...coverage };
    for (const key of Object.keys(all) as Array<keyof typeof all>) {
      all[key] = { ...all[key], eventHistoryComplete: true, enabled: true, availability: 'available' };
    }
    expect(eventHistoryCompleteForAll(all)).toBe(true);
  });
});

describe('a source that fails keeps what it read', () => {
  it('retains earlier pages, marks itself errored, and does not stop its siblings', async () => {
    const { index } = makeIndex([
      fakeSource({ id: 'trackers', prefix: 'tracker:', ids: ids(300), failOnPage: 1 }),
      fakeSource({ id: 'docs', prefix: 'doc:', ids: ids(5, 'd') }),
    ]);

    const state = await index.load();

    expect(state.coverage.trackers.availability).toBe('error');
    expect(state.coverage.trackers.message).toMatch(/blew up/);
    expect(state.coverage.trackers.indexed).toBe(100);
    expect(state.coverage.trackers.complete).toBe(false);
    // Discarding the first page would turn a partial answer into a blank one.
    expect(state.records.filter(r => r.id.startsWith('tracker:'))).toHaveLength(100);
    expect(state.coverage.docs.indexed).toBe(5);
    expect(state.status).toBe('ready');
  });

  it('never reports an unavailable source as an empty one', async () => {
    const { index } = makeIndex([
      fakeSource({ availability: 'unavailable', message: 'gh is not installed', total: null }),
    ]);

    const { coverage } = await index.load();

    expect(coverage.trackers.availability).toBe('unavailable');
    expect(coverage.trackers.message).toBe('gh is not installed');
    expect(coverage.trackers.complete).toBe(false);
  });
});

describe('concurrent loads', () => {
  it('preserves the committed snapshot while a newer load runs', async () => {
    const source = fakeSource({ ids: ids(5) });
    const { index } = makeIndex([source]);

    await index.load();
    expect(index.getState().records).toHaveLength(5);

    // Hold the second load open at its first page.
    let unblock!: () => void;
    const held = new Promise<void>(resolve => { unblock = resolve; });
    source.page = async () => {
      await held;
      return { records: [record('tracker:new')], edges: [], rows: 1 };
    };
    const second = index.load();
    await Promise.resolve();

    expect(index.getState().status).toBe('loading');
    // The user is still looking at a complete answer, not a blank pane.
    expect(index.getState().records).toHaveLength(5);

    unblock();
    await second;
    expect(index.getState().records.map(r => r.id)).toEqual(['tracker:new']);
  });

  it('discards a superseded generation instead of letting it publish', async () => {
    const source = fakeSource({ ids: ids(3) });
    const { index } = makeIndex([source]);
    const seen: ProjectIndexState[] = [];
    index.subscribe(s => seen.push(s));

    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    source.page = async () => {
      await firstHeld;
      return { records: [record('tracker:stale')], edges: [], rows: 1 };
    };
    const first = index.load();
    await Promise.resolve();

    // A second load supersedes the first. `load` awaits the prior run's
    // settlement, so releasing it is what lets the second one start.
    const second = index.load();
    releaseFirst();
    source.page = async () => ({ records: [record('tracker:fresh')], edges: [], rows: 1 });
    await Promise.all([first, second]);

    expect(index.getState().records.map(r => r.id)).toEqual(['tracker:fresh']);
    expect(seen.some(s => s.records.some(r => r.id === 'tracker:stale'))).toBe(false);
  });
});

describe('explicit cancellation settles', () => {
  it('leaves a settled status and a cancelled phase, not a load that never ends', async () => {
    const source = fakeSource({ ids: ids(5) });
    const { index } = makeIndex([source]);
    await index.load();

    let unblock!: () => void;
    const held = new Promise<void>(resolve => { unblock = resolve; });
    source.page = async () => {
      await held;
      return { records: [record('tracker:new')], edges: [], rows: 1 };
    };
    const second = index.load();
    await Promise.resolve();
    expect(index.getState().status).toBe('loading');

    index.cancel();
    unblock();
    await second;

    // The user asked to stop. A spinner that never clears is a worse outcome
    // than the load they cancelled.
    expect(index.getState().status).toBe('ready');
    expect(index.getState().progress.phase).toBe('cancelled');
    // The previously committed answer is what they are left looking at.
    expect(index.getState().records).toHaveLength(5);
  });

  it('reports idle when there was never a committed snapshot to fall back to', async () => {
    const source = fakeSource({ ids: ids(5) });
    const { index } = makeIndex([source]);

    let unblock!: () => void;
    const held = new Promise<void>(resolve => { unblock = resolve; });
    source.page = async () => {
      await held;
      return { records: [], edges: [], rows: 0 };
    };
    const first = index.load();
    await Promise.resolve();
    index.cancel();
    unblock();
    await first;

    expect(index.getState().status).toBe('idle');
    expect(index.getState().progress.phase).toBe('cancelled');
  });

  it('still publishes nothing for a load superseded by another load', async () => {
    const source = fakeSource({ ids: ids(3) });
    const { index } = makeIndex([source]);
    const phases: string[] = [];
    index.subscribe(s => phases.push(s.progress.phase));

    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    source.page = async () => {
      await firstHeld;
      return { records: [record('tracker:stale')], edges: [], rows: 1 };
    };
    const first = index.load();
    await Promise.resolve();
    const second = index.load();
    releaseFirst();
    source.page = async () => ({ records: [record('tracker:fresh')], edges: [], rows: 1 });
    await Promise.all([first, second]);

    // Superseded is not cancelled: the user did not ask to stop, so nothing
    // should announce a cancellation to them.
    expect(phases).not.toContain('cancelled');
    expect(index.getState().status).toBe('ready');
  });
});

describe('three concurrent loads', () => {
  it('runs one at a time and the last caller wins', async () => {
    const running: string[] = [];
    const executed: string[] = [];
    let overlapped = false;
    const makeSource = (tag: string) => {
      const source = fakeSource({ ids: [tag] });
      source.prepare = async () => {
        executed.push(tag);
        running.push(tag);
        if (running.length > 1) overlapped = true;
        await new Promise(resolve => setTimeout(resolve, 1));
        running.pop();
        return { availability: 'available', total: 1 };
      };
      source.page = async () => ({ records: [record(`tracker:${tag}`)], edges: [], rows: 1 });
      return source;
    };
    const { host } = createTestHost();
    const sources = [makeSource('a')];
    const index = new ProjectIndex(host, { cache: false }, { sources, scheduler: { interPageDelayMs: 0 } });

    const first = index.load();
    // A run starts on a microtask, so let 'a' actually get going before the
    // other two pile on. Each caller swaps in its own source so we can see
    // which ones executed.
    await new Promise(resolve => setTimeout(resolve, 0));
    sources[0] = makeSource('b');
    const second = index.load();
    sources[0] = makeSource('c');
    const third = index.load();
    await Promise.all([first, second, third]);

    // Two runs mutating the same source objects at once corrupts their
    // per-run accumulators; the queue must serialize them.
    expect(overlapped).toBe(false);
    // 'b' was superseded by 'c' while still queued, so it never ran at all.
    expect(executed).toEqual(['a', 'c']);
    expect(index.getState().records.map(r => r.id)).toEqual(['tracker:c']);
  });
});

describe('progress publishes keep unchanged data identical', () => {
  it('does not rebuild records and edges for a progress-only tick', async () => {
    const { index } = makeIndex([
      fakeSource({ id: 'trackers', prefix: 'tracker:', ids: ids(3) }),
      fakeSource({ id: 'docs', prefix: 'doc:', ids: ids(3, 'd') }),
    ]);
    await index.load();

    const states: ProjectIndexState[] = [];
    index.subscribe(s => states.push(s));
    await index.load();

    // After a snapshot is committed, intermediate publishes carry progress
    // only. Handing the shell a fresh array each tick forces it to recompute
    // its whole view model for data that did not change.
    const loading = states.filter(s => s.status === 'loading');
    expect(loading.length).toBeGreaterThan(1);
    const first = loading[0]!;
    for (const state of loading) {
      expect(state.records).toBe(first.records);
      expect(state.edges).toBe(first.edges);
      expect(state.unresolvedEdgeIds).toBe(first.unresolvedEdgeIds);
      expect(state.generatedAt).toBe(first.generatedAt);
    }
    // Progress itself still advances, or the ticks would be pointless.
    expect(loading.at(-1)!.progress.completedSources).toBeGreaterThan(
      loading[0]!.progress.completedSources,
    );
  });
});

describe('refresh reconciles removals', () => {
  it('drops a record the source no longer returns and leaves other sources alone', async () => {
    const trackers = fakeSource({ id: 'trackers', prefix: 'tracker:', ids: ['a', 'b', 'c'] });
    const docs = fakeSource({ id: 'docs', prefix: 'doc:', ids: ['x'] });
    const prepared = vi.fn();
    docs.prepare = async () => {
      prepared();
      return { availability: 'available', total: 1 };
    };
    const { index } = makeIndex([trackers, docs]);

    await index.load();
    expect(prepared).toHaveBeenCalledTimes(1);

    trackers.page = async () => ({
      records: [record('tracker:a'), record('tracker:c')],
      edges: [],
      rows: 2,
    });
    const state = await index.refresh({ sources: ['trackers'] });

    expect(state.records.map(r => r.id).sort()).toEqual(['doc:x', 'tracker:a', 'tracker:c']);
    // A refresh of one source must not re-run, or invalidate, another.
    expect(prepared).toHaveBeenCalledTimes(1);
    expect(state.coverage.docs.indexed).toBe(1);
  });
});

describe('relations to records outside the index', () => {
  it('keeps the relation, names it unresolved, and can fetch the other end', async () => {
    const edge: ProjectGraphEdge = {
      id: 'tracker:a->session:elsewhere',
      type: 'worked_on_in',
      sourceId: 'tracker:a',
      targetId: 'session:elsewhere',
      provenance: { kind: 'recorded', basis: 'An explicit link.' },
    };
    const sessions = fakeSource({ id: 'sessions', prefix: 'session:', ids: [] });
    const { index } = makeIndex([fakeSource({ ids: ['a'], edges: [edge] }), sessions]);

    const state = await index.load();

    expect(state.edges.map(e => e.id)).toContain(edge.id);
    expect(state.unresolvedEdgeIds).toEqual([edge.id]);

    const resolved = await index.resolveNode('session:elsewhere');
    expect(resolved?.id).toBe('session:elsewhere');
    // A detail fetch is not an enumeration: it must not inflate `indexed`.
    expect(index.getState().coverage.sessions.detailLoaded).toBe(1);
    expect(index.getState().coverage.sessions.indexed).toBe(0);
    expect(index.getState().unresolvedEdgeIds).toEqual([]);
  });
});

describe('safety maximums are explicit only', () => {
  it('applies no ceiling when the caller sets none', async () => {
    // Asserted on the resolved options rather than by indexing past a former
    // default: a 60,000-record run proved the same thing and cost 1.7s.
    expect(resolveOptions({}).safetyMax).toEqual({});
    expect(resolveOptions({ safetyMax: { git: 10 } }).safetyMax).toEqual({ git: 10 });

    const { index } = makeIndex([fakeSource({ ids: ids(3_000) })]);
    const { coverage } = await index.load();

    // An omitted safetyMax means no limit. A built-in default silently capped
    // a corpus the shell had explicitly asked to index in full.
    expect(coverage.trackers.indexed).toBe(3_000);
    expect(coverage.trackers.truncated).toBe(false);
    expect(coverage.trackers.complete).toBe(true);
  });

  it('reports a truncation that happened during enumeration, not just during paging', async () => {
    const source = fakeSource({ ids: ids(3) });
    source.prepare = async () => ({
      availability: 'available',
      total: 900,
      truncated: true,
      truncationReason: '900 files matched; stopped at the 3 safety maximum.',
    });
    const { index } = makeIndex([source]);

    const { coverage } = await index.load();

    // A filesystem source truncates while ENUMERATING, before any page runs.
    // Leaving `truncated` false there reported a capped answer as complete.
    expect(coverage.trackers.truncated).toBe(true);
    expect(coverage.trackers.truncationReason).toMatch(/900/);
    expect(coverage.trackers.complete).toBe(false);
  });
});

describe('detail resolution for records already indexed', () => {
  it('fetches and caches a bounded body for an indexed record', async () => {
    const source = fakeSource({ ids: ['a'] });
    let calls = 0;
    source.loadDetail = async (_ctx, nodeId) => {
      calls += 1;
      return { body: `body of ${nodeId}`, fields: { bodyVersion: 2 } };
    };
    const { index } = makeIndex([source]);
    await index.load();

    const detail = await index.loadDetail('tracker:a');
    const again = await index.loadDetail('tracker:a');

    expect(detail?.body).toBe('body of tracker:a');
    // Cached per node: asking twice must not re-read the source.
    expect(calls).toBe(1);
    expect(again?.body).toBe(detail?.body);

    const node = index.getState().records.find(r => r.id === 'tracker:a');
    expect(node?.fields?.body).toBe('body of tracker:a');
    expect(node?.fields?.bodyVersion).toBe(2);
    expect(index.getState().coverage.trackers.detailLoaded).toBe(1);
  });

  it('refuses detail for a disabled source and for a source that offers none', async () => {
    const withDetail = fakeSource({ id: 'trackers', ids: ['a'] });
    withDetail.loadDetail = async () => ({ body: 'x' });
    const noDetail = fakeSource({ id: 'sessions', prefix: 'session:', ids: ['s'] });
    const { index } = makeIndex([withDetail, noDetail], { sources: { trackers: false } });
    await index.load();

    // Disabled means the shell has excluded that evidence; a detail fetch must
    // not smuggle it back in.
    await expect(index.loadDetail('tracker:a')).resolves.toBeNull();
    // Sessions deliberately expose no detail — the only extra data is the
    // transcript, and the index never reads transcripts.
    await expect(index.loadDetail('session:s')).resolves.toBeNull();
  });

  it('discards a detail that arrives after a newer load superseded it', async () => {
    const source = fakeSource({ ids: ['a'] });
    let unblock!: () => void;
    const held = new Promise<void>(resolve => { unblock = resolve; });
    source.loadDetail = async () => {
      await held;
      return { body: 'stale body' };
    };
    const { index } = makeIndex([source]);
    await index.load();

    const pending = index.loadDetail('tracker:a');
    await index.load();
    unblock();

    await expect(pending).resolves.toBeNull();
    expect(index.getState().records.find(r => r.id === 'tracker:a')?.fields?.body).toBeUndefined();
  });
});

describe('on-demand commit file evidence', () => {
  it('adds directory evidence and counts it as detail, not as enumeration', async () => {
    const sha = 'a'.repeat(40);
    const { host } = createTestHost({
      workspacePath: '/ws',
      execs: [
        { match: /rev-parse/, handle: () => ({ stdout: 'true\n' }) },
        { match: /rev-list --count/, handle: () => ({ stdout: '1\n' }) },
        {
          match: /--name-only/,
          handle: () => ({ stdout: `__COMMIT__${sha}\npackages/electron/src/main/a.ts\n` }),
        },
        {
          match: /git log/,
          handle: () => ({ stdout: `__COMMIT__${sha}\x1Fsubject\x1Fme\x1F2026-01-01T00:00:00Z` }),
        },
      ],
    });
    const index = new ProjectIndex(host, { cache: false }, { scheduler: { interPageDelayMs: 0 } });
    await index.load();

    expect(index.getState().coverage.git.indexed).toBe(1);
    expect(index.getState().coverage.git.detailLoaded).toBe(0);

    const result = await index.loadCommitEvidence({ shas: [sha] });

    expect(result.covered).toBe(1);
    expect(index.getState().edges.map(e => e.targetId)).toContain('dir:packages/electron/main');
    // Header enumeration and detail retrieval are separate numbers; folding
    // them together is what makes "N of M" unreadable.
    expect(index.getState().coverage.git.indexed).toBe(1);
    expect(index.getState().coverage.git.detailLoaded).toBe(1);
  });
});

describe('resolving a file: reference', () => {
  it('routes a file identity to the source that owns its canonical id', async () => {
    const plans = fakeSource({ id: 'plans', prefix: 'plan:', ids: [] });
    let asked: string | null = null;
    plans.resolve = async (_ctx, nodeId) => {
      asked = nodeId;
      return record(nodeId);
    };
    const { index } = makeIndex([fakeSource({ ids: ['a'] }), plans]);
    await index.load();

    // A session's `linkedTrackerItemIds` can carry `file:` refs whose target
    // has not been indexed. No source owns a `file:` id, so without this the
    // affordance behind an unresolved endpoint silently did nothing.
    const resolved = await index.resolveNode('file:nimbalyst-local/plans/a.md');

    expect(asked).toBe('plan:nimbalyst-local/plans/a.md');
    expect(resolved?.id).toBe('plan:nimbalyst-local/plans/a.md');
  });

  it('returns null for a file identity no source can claim, without throwing', async () => {
    const { index } = makeIndex([fakeSource({ ids: ['a'] })]);
    await index.load();

    await expect(index.resolveNode('file:packages/electron/src/main/index.ts')).resolves.toBeNull();
    await expect(index.loadDetail('file:packages/electron/src/main/index.ts')).resolves.toBeNull();
  });
});

describe('hydrate then load', () => {
  it('paints the cache first and the load replaces it, clearing fromCache', async () => {
    const { host } = createTestHost();
    const writer = new ProjectIndex(host, {}, { sources: [fakeSource({ ids: ids(4) })], scheduler: { interPageDelayMs: 0 } });
    await writer.load();

    // The shell hydrates before its first load, so both must compose cleanly:
    // the cached paint must not survive into the loaded state, and the loaded
    // state must not inherit `fromCache`.
    const index = new ProjectIndex(host, {}, { sources: [fakeSource({ ids: ids(2) })], scheduler: { interPageDelayMs: 0 } });
    expect(await index.hydrateFromCache()).toBe(true);
    expect(index.getState().records).toHaveLength(4);
    expect(index.getState().fromCache).toBe(true);

    const loaded = await index.load();

    expect(loaded.records).toHaveLength(2);
    expect(loaded.fromCache).toBe(false);
    // Records the cache held but the source no longer returns are gone, not
    // merged in behind the fresh ones.
    expect(loaded.records.every(r => r.fields?.cachedLite === undefined)).toBe(true);
  });
});

describe('commit evidence for a range outside the configured window', () => {
  it('fetches explicit commits regardless of the event scope', async () => {
    const sha = 'b'.repeat(40);
    const { host, execCalls } = createTestHost({
      workspacePath: '/ws',
      execs: [
        { match: /rev-parse/, handle: () => ({ stdout: 'true\n' }) },
        { match: /rev-list --count/, handle: () => ({ stdout: '1\n' }) },
        { match: /--name-only/, handle: () => ({ stdout: `__COMMIT__${sha}\ndocs/old.md\n` }) },
        { match: /git log/, handle: () => ({ stdout: `__COMMIT__${sha}\x1Fs\x1Fme\x1F2020-01-01T00:00:00Z` }) },
      ],
    });
    const now = Date.now();
    const index = new ProjectIndex(
      host,
      { cache: false, eventScope: { mode: 'window', window: { startMs: now - 86_400_000, endMs: now } } },
      { scheduler: { interPageDelayMs: 0 } },
    );
    await index.load();

    // Opening an old linked commit must work even though the current view
    // window is the last day: a sha lookup is not a window query.
    const result = await index.loadCommitEvidence({ shas: [sha] });

    expect(result.covered).toBe(1);
    expect(index.getState().edges.map(e => e.targetId)).toContain('dir:docs');
    const evidenceCall = execCalls.find(c => /--name-only/.test(c.command))!;
    expect(evidenceCall.command).not.toMatch(/--since=/);
  });
});

describe('disabling a source', () => {
  it('does not run it and says it is off rather than empty', async () => {
    const onPrepare = vi.fn();
    const { index } = makeIndex([fakeSource({ ids: ids(3), onPrepare })], {
      sources: { trackers: false },
    });

    const { coverage, records } = await index.load();

    expect(onPrepare).not.toHaveBeenCalled();
    expect(coverage.trackers.availability).toBe('disabled');
    expect(coverage.trackers.enabled).toBe(false);
    expect(records).toHaveLength(0);
  });
});

describe('timing and paint ordering', () => {
  it('reports measured timing for every attempted source, including preparation', async () => {
    const { index } = makeIndex([
      fakeSource({ id: 'trackers', ids: ids(250) }),
      fakeSource({ id: 'github', prefix: 'pr:', availability: 'unavailable', message: 'no gh', total: null }),
    ]);

    const { timings, coverage } = await index.load();

    expect(timings.trackers?.pages).toBe(3);
    expect(timings.trackers?.totalMs).toBeGreaterThanOrEqual(0);
    expect(timings.trackers?.averagePageMs).toBeGreaterThanOrEqual(0);
    // A source that never paged still cost time to probe; omitting it hides
    // where a slow load actually went.
    expect(timings.github?.prepareMs).toBeGreaterThanOrEqual(0);
    expect(timings.github?.pages).toBe(0);
    expect(coverage.github.availability).toBe('unavailable');
  });

  it('indexes cheap local metadata before slow network sources', async () => {
    const order: string[] = [];
    const spy = (id: 'sessions' | 'trackers' | 'docs' | 'github' | 'git') => {
      const source = fakeSource({ id, prefix: `${id}:`, ids: ['a'] });
      const prepare = source.prepare.bind(source);
      source.prepare = async ctx => {
        order.push(id);
        return prepare(ctx);
      };
      return source;
    };
    const { index } = makeIndex([spy('github'), spy('git'), spy('docs'), spy('trackers'), spy('sessions')]);

    await index.load();

    // Records paint as they arrive on a first load, so the sources the user is
    // actually waiting on must not queue behind a network round trip.
    expect(order.indexOf('sessions')).toBeLessThan(order.indexOf('github'));
    expect(order.indexOf('trackers')).toBeLessThan(order.indexOf('github'));
    expect(order.indexOf('docs')).toBeLessThan(order.indexOf('git'));
    expect(order.at(-1)).toBe('github');
  });

  it('only reaches ready once, at the end, so the shell can build geometry on it', async () => {
    const { index } = makeIndex([
      fakeSource({ id: 'trackers', ids: ids(250) }),
      fakeSource({ id: 'docs', prefix: 'doc:', ids: ids(3, 'd') }),
    ]);
    const statuses: string[] = [];
    index.subscribe(s => statuses.push(s.status));

    await index.load();

    // Intermediate publishes are all `loading`. An area registry built on a
    // mid-load state would be rebuilt, and the geometry would shift.
    expect(statuses.filter(s => s === 'ready')).toHaveLength(1);
    expect(statuses.at(-1)).toBe('ready');
    expect(index.getState().progress.phase).toBe('done');
  });
});

describe('persistence', () => {
  it('writes storage once per load, not on every progress tick', async () => {
    const { host, storage } = createTestHost();
    let writes = 0;
    const set = host.storage.set.bind(host.storage);
    (host.storage as { set: typeof set }).set = async (key, value) => {
      writes += 1;
      return set(key, value);
    };
    const index = new ProjectIndex(
      host,
      { pageSize: 10 },
      {
        sources: [fakeSource({ ids: ids(95) })],
        // `minPageSize` lowered too: the scheduler's floor would otherwise
        // clamp a 10-record page up to 80 and this would only be two pages.
        scheduler: { interPageDelayMs: 0, fastMs: -1, minPageSize: 10 },
      },
    );

    const state = await index.load();

    // 95 records at a pinned page size of 10 is ten pages; the whole index is
    // serialized once at commit, not once per page.
    expect(state.coverage.trackers.pages).toBe(10);
    expect(writes).toBe(1);
    expect(storage.size).toBe(1);
  });

  it('rehydrates a previous index without touching any source', async () => {
    const { host, storage } = createTestHost();
    const source = fakeSource({ ids: ids(4) });
    const first = new ProjectIndex(host, { pageSize: 100 }, { sources: [source], scheduler: { interPageDelayMs: 0 } });
    await first.load();

    const onPrepare = vi.fn();
    const second = new ProjectIndex(
      host,
      { pageSize: 100 },
      { sources: [fakeSource({ ids: ids(4), onPrepare })], scheduler: { interPageDelayMs: 0 } },
    );
    const hydrated = await second.hydrateFromCache();

    expect(hydrated).toBe(true);
    expect(second.getState().records).toHaveLength(4);
    expect(second.getState().coverage.trackers.lastIndexedAt).toBeGreaterThan(0);
    expect(onPrepare).not.toHaveBeenCalled();
    expect(storage.size).toBeGreaterThan(0);
    // A hydrated state is a warm paint over a lite projection, not a load. The
    // shell defers durable geometry until a `ready` state that is not cached,
    // so nothing it builds has to be rebuilt and shifted.
    expect(second.getState().fromCache).toBe(true);
    expect(second.getState().records[0]!.fields?.cachedLite).toBe(true);
  });

  it('rejects a cache written under different source or archive options', async () => {
    const { host } = createTestHost();
    const write = new ProjectIndex(
      host,
      { includeArchived: true },
      { sources: [fakeSource({ ids: ids(4) })], scheduler: { interPageDelayMs: 0 } },
    );
    await write.load();

    // The shell has since excluded archived records. Painting a cache that
    // contains them flashes evidence the user asked not to see.
    const narrower = new ProjectIndex(host, { includeArchived: false }, { sources: [fakeSource({ ids: ids(4) })] });
    expect(await narrower.hydrateFromCache()).toBe(false);
    expect(narrower.getState().records).toHaveLength(0);

    const fewerSources = new ProjectIndex(host, { sources: { trackers: false } }, { sources: [fakeSource({ ids: ids(4) })] });
    expect(await fewerSources.hydrateFromCache()).toBe(false);
  });

  it('rejects a cache whose stored shape is not what it claims', async () => {
    const { host, storage } = createTestHost();
    storage.set('projectIndex.v1', { version: 1, generatedAt: Date.now(), sources: { trackers: 'not a slice' } });
    const index = new ProjectIndex(host, {}, { sources: [fakeSource({ ids: ids(2) })] });

    expect(await index.hydrateFromCache()).toBe(false);
  });

  it('drops the heavy detail bag so a real corpus fits under the size ceiling', async () => {
    // Measured on this workspace: tracker `data` is 26.6 MB over 5,150 rows and
    // session `metadata` averages 2.5 KB over 6,253. Caching records whole put
    // every real corpus over the ceiling, so nothing was ever cached.
    const heavy = 'x'.repeat(5_000);
    const source = fakeSource({ ids: ids(2_000) });
    const original = source.page.bind(source);
    source.page = async (ctx, cursor, size) => {
      const page = await original(ctx, cursor, size);
      return {
        ...page,
        records: page.records.map(r => ({ ...r, fields: { id: r.id, archived: false, data: { blob: heavy } } })),
      };
    };
    const { host, storage } = createTestHost();
    const index = new ProjectIndex(host, {}, { sources: [source], scheduler: { interPageDelayMs: 0 } });

    await index.load();
    const written = storage.get('projectIndex.v1') as { sources: Record<string, { records: Array<{ fields?: Record<string, unknown> }> }> };
    const cached = written.sources.trackers!.records;

    expect(cached).toHaveLength(2_000);
    expect(cached[0]!.fields?.data).toBeUndefined();
    expect(cached[0]!.fields?.archived).toBe(false);
    expect(JSON.stringify(written).length).toBeLessThan(8 * 1024 * 1024);
    // The live records keep everything; only the cached projection is reduced.
    expect(index.getState().records[0]!.fields?.data).toBeDefined();
  });
});
