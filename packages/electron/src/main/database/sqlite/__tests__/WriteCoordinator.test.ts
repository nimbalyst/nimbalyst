/**
 * Pure-logic tests for WriteCoordinator using a fake database handle.
 * We don't import better-sqlite3; the only better-sqlite3 surface the
 * coordinator touches is `db.transaction(fn)`, which we mock.
 *
 * Note: covers batching, error isolation, background-lane chunking, and the
 * "hot writes don't starve" invariant. Real native-binding tests live
 * separately and require `better-sqlite3` installed.
 */

import { describe, expect, it, vi } from 'vitest';
import { WriteCoordinator, type BackgroundWork } from '../WriteCoordinator';

interface FakeStmt {
  changes: number;
}

class FakeDatabase {
  // Track every transaction commit so the test can assert batching.
  public commits: Array<{ size: number; succeeded: boolean }> = [];
  public sequence: string[] = [];

  transaction<F extends (...args: any[]) => any>(fn: F): F {
    const self = this;
    return ((...args: any[]) => {
      const before = self.sequence.length;
      try {
        const result = fn(...args);
        self.commits.push({ size: self.sequence.length - before, succeeded: true });
        return result;
      } catch (err) {
        self.commits.push({ size: self.sequence.length - before, succeeded: false });
        throw err;
      }
    }) as F;
  }

  record(tag: string): void {
    this.sequence.push(tag);
  }
}

function makeCoordinator(opts: Partial<ConstructorParameters<typeof WriteCoordinator>[1]> = {}) {
  const db = new FakeDatabase();
  // The coordinator only types `db` as better-sqlite3 Database; the fake is
  // close enough at runtime.
  const c = new WriteCoordinator(db as unknown as import('better-sqlite3').Database, {
    batchWindowMs: 5,
    ...opts,
  });
  return { db, coordinator: c };
}

describe('WriteCoordinator hot lane', () => {
  it('batches writes arriving within the window into one transaction', async () => {
    const { db, coordinator } = makeCoordinator({ batchWindowMs: 10 });

    const p1 = coordinator.write((fakeDb) => {
      (fakeDb as unknown as FakeDatabase).record('a');
      return 'a';
    });
    const p2 = coordinator.write((fakeDb) => {
      (fakeDb as unknown as FakeDatabase).record('b');
      return 'b';
    });

    expect(await p1).toBe('a');
    expect(await p2).toBe('b');
    // Both writes landed in the same transaction.
    expect(db.commits).toHaveLength(1);
    expect(db.commits[0]).toEqual({ size: 2, succeeded: true });
    expect(db.sequence).toEqual(['a', 'b']);
  });

  it('serializes batches in arrival order', async () => {
    const { db, coordinator } = makeCoordinator({ batchWindowMs: 1 });

    const first = coordinator.write((fakeDb) => {
      (fakeDb as unknown as FakeDatabase).record('1');
    });
    await first;
    const second = coordinator.write((fakeDb) => {
      (fakeDb as unknown as FakeDatabase).record('2');
    });
    await second;

    expect(db.sequence).toEqual(['1', '2']);
    expect(db.commits).toHaveLength(2);
  });

  it('one bad write does not block its siblings (rollback then per-item retry)', async () => {
    const { coordinator } = makeCoordinator({ batchWindowMs: 5 });
    const good1 = coordinator.write(() => 'ok-1');
    const bad = coordinator.write(() => {
      throw new Error('boom');
    });
    const good2 = coordinator.write(() => 'ok-2');

    expect(await good1).toBe('ok-1');
    await expect(bad).rejects.toThrow('boom');
    expect(await good2).toBe('ok-2');
  });

  it('drain resolves once all pending writes settle', async () => {
    const { coordinator } = makeCoordinator();
    coordinator.write(() => 'x');
    coordinator.write(() => 'y');
    await coordinator.drain();
    // No assertions on db sequence here; the point is that drain() returns
    // without hanging when there is no pending work.
  });

  it('close() rejects pending writes', async () => {
    const { coordinator } = makeCoordinator({ batchWindowMs: 50 });
    const p = coordinator.write(() => 'never');
    coordinator.close();
    await expect(p).rejects.toThrow(/closed with pending writes/);
  });
});

describe('WriteCoordinator background lane', () => {
  it('runs chunks until done and resolves with the final result', async () => {
    const { db, coordinator } = makeCoordinator();

    let chunksRun = 0;
    const work: BackgroundWork<string> = {
      name: 'fts-rebuild',
      chunk: (fakeDb) => {
        chunksRun += 1;
        (fakeDb as unknown as FakeDatabase).record(`chunk-${chunksRun}`);
        if (chunksRun >= 3) return { done: true, result: 'done' };
        return { done: false };
      },
    };

    const result = await coordinator.runBackground(work);
    expect(result).toBe('done');
    expect(chunksRun).toBe(3);
    expect(db.sequence).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
    // Each chunk is its own transaction.
    expect(db.commits).toHaveLength(3);
  });

  it('hot-lane writes get scheduled between bg chunks (no starvation)', async () => {
    const { db, coordinator } = makeCoordinator();

    const hotResolutions: string[] = [];

    const bg = coordinator.runBackground<string>({
      name: 'big',
      chunk: (fakeDb) => {
        (fakeDb as unknown as FakeDatabase).record('bg');
        return { done: hotResolutions.length >= 3, result: 'bg-done' };
      },
    });

    // Enqueue several hot writes after the bg work starts.
    const hotPromises: Array<Promise<void>> = [];
    for (let i = 0; i < 3; i++) {
      const tag = `hot-${i}`;
      hotPromises.push(
        coordinator
          .write((fakeDb) => {
            (fakeDb as unknown as FakeDatabase).record(tag);
          })
          .then(() => {
            hotResolutions.push(tag);
          }),
      );
    }

    await Promise.all([bg, ...hotPromises]);

    // We don't pin the exact interleaving (event-loop timing varies) but every
    // hot write must have completed AND at least one 'hot-*' marker must
    // appear in the sequence before the final 'bg' marker.
    expect(hotResolutions).toHaveLength(3);
    const lastBgIdx = db.sequence.lastIndexOf('bg');
    const firstHotIdx = db.sequence.findIndex((s) => s.startsWith('hot-'));
    expect(firstHotIdx).toBeGreaterThanOrEqual(0);
    expect(firstHotIdx).toBeLessThan(lastBgIdx);
  });

  it('fires onSlowChunk when a chunk runs past the warn threshold', async () => {
    const onSlowChunk = vi.fn();
    const { coordinator } = makeCoordinator({ slowChunkWarnMs: 5, onSlowChunk });

    await coordinator.runBackground<void>({
      name: 'slow',
      chunk: () => {
        // Busy-wait past the threshold so the hook fires.
        const start = performance.now();
        while (performance.now() - start < 15) {
          /* burn ms */
        }
        return { done: true };
      },
    });

    expect(onSlowChunk).toHaveBeenCalled();
    expect(onSlowChunk.mock.calls[0][0].name).toBe('slow');
  });

  it('queues bg ops serially', async () => {
    const { db, coordinator } = makeCoordinator();

    const order: string[] = [];
    const first = coordinator.runBackground<void>({
      name: 'first',
      chunk: () => {
        order.push('first');
        return { done: true };
      },
    });
    const second = coordinator.runBackground<void>({
      name: 'second',
      chunk: () => {
        order.push('second');
        return { done: true };
      },
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(db.commits).toHaveLength(2);
  });
});
