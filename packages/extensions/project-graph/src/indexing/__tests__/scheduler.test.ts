// @vitest-environment node

/**
 * Adaptive paging, plus a timing harness over synthetic corpora.
 *
 * The harness is here rather than in a script so it runs in CI and cannot rot:
 * it asserts the scaling PROPERTIES (page count stays bounded, the worker is
 * ceded between pages, a slow source shrinks its pages) rather than wall-clock
 * numbers, which would be a flaky assertion about the machine. It prints the
 * measured shape so a profiling pass has a baseline to compare against.
 */
import { describe, expect, it } from 'vitest';
import { PageScheduler } from '../scheduler';
import { ProjectIndex } from '../projectIndex';
import { createTestHost } from '../../adapters/__tests__/testHost';
import type { IndexSource } from '../types';
import type { ProjectGraphNode } from '../../types';

describe('page scheduler', () => {
  it('shrinks immediately on a slow page and grows gradually on fast ones', () => {
    const scheduler = new PageScheduler({ initialPageSize: 400, slowMs: 600, fastMs: 150 });

    scheduler.record(50);
    expect(scheduler.pageSize).toBe(600);
    scheduler.record(50);
    expect(scheduler.pageSize).toBe(900);

    // One over-long page already cost the user latency; creeping down would
    // repeat that cost several more times before recovering.
    scheduler.record(900);
    expect(scheduler.pageSize).toBe(450);

    // A page inside the band is fine as it is.
    scheduler.record(300);
    expect(scheduler.pageSize).toBe(450);
  });

  it('respects its floor and ceiling', () => {
    const scheduler = new PageScheduler({ initialPageSize: 100, minPageSize: 80, maxPageSize: 120, fastMs: 1000 });

    scheduler.record(0);
    expect(scheduler.pageSize).toBe(120);
    scheduler.record(10_000);
    scheduler.record(10_000);
    expect(scheduler.pageSize).toBe(80);
  });

  it('records the slowest page so a stall is visible after the fact', () => {
    const scheduler = new PageScheduler({ initialPageSize: 100 });
    scheduler.record(20);
    scheduler.record(740);
    scheduler.record(30);

    expect(scheduler.timing).toMatchObject({ pages: 3, slowestPageMs: 740, totalMs: 790 });
  });
});

/** A source that returns `size` synthetic records with a settable per-page cost. */
function syntheticSource(size: number, costMs: () => number): IndexSource {
  const record = (i: number): ProjectGraphNode => ({
    id: `tracker:${String(i).padStart(7, '0')}`,
    type: 'task',
    label: `record ${i}`,
    category: 'delivery',
    source: 'tracker',
    visibility: 'local',
    createdAt: 1_700_000_000_000 + i * 1000,
  });
  return {
    id: 'trackers',
    label: 'synthetic',
    async prepare() {
      return { availability: 'available', total: size };
    },
    async page(_ctx, cursor, pageSize) {
      const cost = costMs();
      if (cost > 0) await new Promise(resolve => setTimeout(resolve, cost));
      const start = cursor ? Number(cursor) : 0;
      const end = Math.min(start + pageSize, size);
      return {
        records: Array.from({ length: end - start }, (_, i) => record(start + i)),
        edges: [],
        cursor: end < size ? String(end) : undefined,
        rows: end - start,
      };
    },
    owns: id => id.startsWith('tracker:'),
  };
}

describe('timing harness over larger synthetic corpora', () => {
  it('keeps the page count bounded as the corpus grows, and cedes between pages', async () => {
    const yields: number[] = [];
    const results: Array<{ size: number; pages: number; records: number }> = [];

    for (const size of [1_000, 10_000, 50_000]) {
      const { host } = createTestHost();
      const index = new ProjectIndex(
        host,
        { cache: false, pageSize: 500 },
        {
          sources: [syntheticSource(size, () => 0)],
          scheduler: {
            interPageDelayMs: 1,
            sleep: async ms => {
              yields.push(ms);
            },
          },
        },
      );
      const state = await index.load();
      results.push({ size, pages: state.coverage.trackers.pages, records: state.records.length });

      expect(state.coverage.trackers.indexed).toBe(size);
      expect(state.coverage.trackers.complete).toBe(true);
    }

    // Adaptive growth means the page count grows far slower than the corpus.
    // A fixed 500-record page would need 100 round trips for 50,000 records;
    // measured here it is well under a quarter of that, and 50x the records
    // costs under 10x the pages.
    const [small, , large] = results;
    expect(large!.pages).toBeLessThan(large!.size / 500 / 4);
    expect(large!.pages).toBeLessThan(small!.pages * 10);
    // Every page boundary cedes the event loop; the database runs on a single
    // worker thread and a tight loop head-of-line-blocks the foreground.
    expect(yields.length).toBeGreaterThanOrEqual(large!.pages - 1);

    // eslint-disable-next-line no-console -- the baseline a profiling pass compares against
    console.log('[index timing]', JSON.stringify(results));
  });

  it('shrinks its pages when the source turns slow', async () => {
    const { host } = createTestHost();
    let call = 0;
    const index = new ProjectIndex(
      host,
      { cache: false, pageSize: 800 },
      {
        sources: [syntheticSource(4_000, () => (call++ === 0 ? 30 : 0))],
        scheduler: { interPageDelayMs: 0, slowMs: 20, fastMs: -1 },
      },
    );

    const state = await index.load();

    expect(state.coverage.trackers.indexed).toBe(4_000);
    // The first page measured slow, so subsequent pages were halved and the
    // run needed more of them than a fixed 800-record page would have.
    expect(state.coverage.trackers.pages).toBeGreaterThan(5);
  });
});
