/**
 * Unit tests for the projection no-op guard (NIM-1559).
 *
 * These pin the core question the projection write paths ask before
 * bumping `updated`: "did anything I write actually change?" A no-op
 * re-scan must answer false so the item's `updated` timestamp does not
 * advance (and a shared item does not re-sync a bogus timestamp).
 */

import { describe, it, expect } from 'vitest';
import {
  projectionValueEqual,
  projectionContentEqual,
  projectionWouldChange,
} from '../projectionUpdateGuard';

describe('projectionValueEqual', () => {
  it('treats null and undefined as interchangeable absent values', () => {
    expect(projectionValueEqual(null, undefined)).toBe(true);
    expect(projectionValueEqual(undefined, null)).toBe(true);
  });

  it('compares string arrays order-sensitively but value-wise', () => {
    expect(projectionValueEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(projectionValueEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(projectionValueEqual([], [])).toBe(true);
  });

  it('compares nested objects key-insensitively to order', () => {
    expect(projectionValueEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(projectionValueEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('projectionContentEqual', () => {
  it('treats null and undefined bodies as equal', () => {
    expect(projectionContentEqual(null, null)).toBe(true);
    expect(projectionContentEqual(undefined, null)).toBe(true);
  });

  it('compares the stored JSON string form of the body', () => {
    const body = JSON.stringify('# Heading\n\nbody');
    expect(projectionContentEqual(body, body)).toBe(true);
    expect(projectionContentEqual(body, JSON.stringify('changed'))).toBe(false);
    expect(projectionContentEqual(null, body)).toBe(false);
  });
});

describe('projectionWouldChange', () => {
  const stored = {
    title: 'Unified tracker system',
    status: 'in-progress',
    priority: 'high',
    tags: ['team'],
    // Keys the indexer never writes -- must be ignored.
    activity: [{ id: 'a1' }],
    linkedSessions: ['s1'],
  };

  it('returns false when re-projecting identical fields (the bug)', () => {
    const reprojected = {
      title: 'Unified tracker system',
      status: 'in-progress',
      priority: 'high',
      tags: ['team'],
    };
    expect(projectionWouldChange(stored, reprojected)).toBe(false);
  });

  it('ignores stored keys the projection does not write', () => {
    // Only projected keys matter; activity/linkedSessions absent from newData.
    expect(
      projectionWouldChange(stored, { status: 'in-progress' }),
    ).toBe(false);
  });

  it('ignores undefined projected values (inline parser omits rich fields)', () => {
    // The inline parser emits `description: undefined` for single-line items,
    // but the stored row has a rich description added via the UI / sync.
    // JSON.stringify drops undefined, so the merge preserves the stored value
    // -> this is NOT a change and must not bump `updated` (NIM-1559 restart bug).
    const withDescription = { ...stored, description: '## Symptoms\n...' };
    const inlineReprojection = {
      title: 'Unified tracker system',
      description: undefined,
      status: 'in-progress',
      priority: 'high',
      owner: undefined,
      tags: ['team'],
      dueDate: undefined,
    };
    expect(projectionWouldChange(withDescription, inlineReprojection)).toBe(false);
  });

  it('returns true when a projected field changes', () => {
    expect(
      projectionWouldChange(stored, { status: 'done' }),
    ).toBe(true);
  });

  it('returns true when a new field appears', () => {
    expect(
      projectionWouldChange(stored, { owner: 'greg' }),
    ).toBe(true);
  });

  it('same content in a different file is not a change (dup id across files)', () => {
    // The same #id[...] marker appears in two files; the row is keyed by id.
    // Re-indexing the second file must compare against the real row (found by
    // id) and see no content change -- only the owning file/line differs,
    // which is positional, not content (NIM-1559 ping-pong bug).
    const reprojectedFromOtherFile = {
      title: 'Unified tracker system',
      status: 'in-progress',
      priority: 'high',
      tags: ['team'],
    };
    expect(projectionWouldChange(stored, reprojectedFromOtherFile)).toBe(false);
  });

  it('treats a null/empty existing row as changed', () => {
    expect(projectionWouldChange(null, { title: 'x' })).toBe(true);
    expect(projectionWouldChange({}, { title: 'x' })).toBe(true);
  });

  it('factors the markdown body when content args are supplied', () => {
    const body = JSON.stringify('# body');
    // identical fields + identical body -> no change
    expect(
      projectionWouldChange(stored, { status: 'in-progress' }, body, body),
    ).toBe(false);
    // identical fields but changed body -> change
    expect(
      projectionWouldChange(
        stored,
        { status: 'in-progress' },
        body,
        JSON.stringify('# new body'),
      ),
    ).toBe(true);
  });
});
