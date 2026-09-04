// @vitest-environment node
/**
 * The resolution ORDER is the only thing worth testing here, and it is worth
 * testing because every step disagrees with the one below it on purpose. Each
 * case below is built so that the weaker rule would produce a different answer
 * — otherwise it would pass whether or not the order is implemented.
 *
 * The reported reason is asserted alongside the outcome. v1 dropped the loser
 * silently, which is what made a history view impossible; "B is gone" and "B is
 * gone because A replaced it" are different products.
 */
import { describe, expect, it } from 'vitest';
import { resolveMemories } from '../resolve.js';
import type { MemoryRecord } from '../types.js';

const T = (iso: string) => new Date(iso).toISOString();
const NOW = Date.parse('2026-09-03T00:00:00.000Z');

function record(factId: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    factId,
    schemaVersion: 3,
    title: factId,
    body: `body of ${factId}`,
    type: 'fact',
    scope: 'project',
    status: 'active',
    confidence: 0.7,
    provenance: { kind: 'user' },
    validFrom: T('2026-01-01T00:00:00.000Z'),
    validTo: null,
    supersedes: [],
    duplicates: [],
    expiresAt: null,
    createdAt: T('2026-01-01T00:00:00.000Z'),
    updatedAt: T('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    redacted: false,
    recallCount: 0,
    lastRecalledAt: null,
    ...over,
  };
}

const ids = (rs: readonly MemoryRecord[]) => rs.map((r) => r.factId).sort();

describe('read-time resolution order', () => {
  it('an explicit supersedes link beats recency, even against a newer page', () => {
    // Recency alone would keep `old` — it is the newer of the two. The link
    // says otherwise, and the link is what a human or a dedup verdict decided.
    const fresh = record('mem_a', {
      validFrom: T('2026-02-01T00:00:00.000Z'),
      supersedes: ['mem_b'],
      duplicates: ['mem_b'],
    });
    const newer = record('mem_b', { validFrom: T('2026-08-01T00:00:00.000Z') });

    const { active, suppressed } = resolveMemories([fresh, newer], { now: NOW });

    expect(ids(active)).toEqual(['mem_a']);
    expect(suppressed).toEqual([
      expect.objectContaining({ reason: 'superseded', by: 'mem_a' }),
    ]);
    expect(suppressed[0].record.factId).toBe('mem_b');
  });

  it('the validTo window beats recency: the newest page is not active once its window closed', () => {
    // Recency alone would pick `closed`; it is newest and nothing supersedes it.
    const closed = record('mem_a', {
      validFrom: T('2026-08-01T00:00:00.000Z'),
      validTo: T('2026-08-20T00:00:00.000Z'),
      duplicates: ['mem_b'],
    });
    const older = record('mem_b', { validFrom: T('2026-03-01T00:00:00.000Z') });

    const { active, suppressed } = resolveMemories([closed, older], { now: NOW });

    expect(ids(active)).toEqual(['mem_b']);
    expect(suppressed).toEqual([expect.objectContaining({ reason: 'expired' })]);
    // No winner id: a closed window is a property of the page itself, not the
    // outcome of a comparison, and inventing a `by` would misreport it.
    expect(suppressed[0].by).toBeUndefined();
  });

  it('an explicit supersedes link beats the validTo window when both apply', () => {
    // `stale` is out of its window AND explicitly superseded. Reporting it as
    // `expired` would be true but useless: the history view needs the id that
    // replaced it, and only the stronger rule carries one.
    const replacement = record('mem_a', {
      validFrom: T('2026-08-25T00:00:00.000Z'),
      supersedes: ['mem_b'],
    });
    const stale = record('mem_b', {
      validFrom: T('2026-01-01T00:00:00.000Z'),
      validTo: T('2026-02-01T00:00:00.000Z'),
    });

    const { active, suppressed } = resolveMemories([replacement, stale], { now: NOW });

    expect(ids(active)).toEqual(['mem_a']);
    expect(suppressed).toEqual([
      expect.objectContaining({ reason: 'superseded', by: 'mem_a' }),
    ]);
  });

  it('recency only applies within a duplicate group, never across unrelated memories', () => {
    // An old constraint does not lose to an unrelated fact written this
    // morning. Without the grouping this is exactly the bug v1's mtime rule
    // had: one global ordering over things that never conflicted.
    const oldConstraint = record('mem_a', {
      type: 'constraint',
      validFrom: T('2026-01-01T00:00:00.000Z'),
    });
    const newFact = record('mem_b', { validFrom: T('2026-09-01T00:00:00.000Z') });

    const { active, suppressed } = resolveMemories([oldConstraint, newFact], { now: NOW });

    expect(ids(active)).toEqual(['mem_a', 'mem_b']);
    expect(suppressed).toEqual([]);
  });

  it('a deleted superseder stops retiring the page it replaced', () => {
    // Resolution is derived from links and dates, not read from `status`. A
    // page marked `superseded` whose replacement was tombstoned has to come
    // back, or deleting a bad memory silently deletes the good one under it.
    const tombstoned = record('mem_a', {
      supersedes: ['mem_b'],
      deletedAt: T('2026-08-30T00:00:00.000Z'),
    });
    const original = record('mem_b', { status: 'superseded' });

    const { active, suppressed } = resolveMemories([tombstoned, original], { now: NOW });

    expect(ids(active)).toEqual(['mem_b']);
    expect(suppressed).toEqual([expect.objectContaining({ reason: 'deleted' })]);
  });

  it('resolves the same way regardless of input order', () => {
    const a = record('mem_a', { validFrom: T('2026-05-01T00:00:00.000Z'), duplicates: ['mem_b'] });
    const b = record('mem_b', { validFrom: T('2026-06-01T00:00:00.000Z') });

    const forward = resolveMemories([a, b], { now: NOW });
    const reverse = resolveMemories([b, a], { now: NOW });

    expect(ids(forward.active)).toEqual(ids(reverse.active));
    expect(ids(forward.active)).toEqual(['mem_b']);
    expect(forward.suppressed[0]).toMatchObject({ reason: 'outdated', by: 'mem_b' });
  });
});
