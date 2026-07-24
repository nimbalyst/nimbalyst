/**
 * Unit tests for the labels CRDT helpers in `trackerLabels.ts`.
 *
 * The integration test in `TrackerSyncEngine.integration.test.ts` proves
 * end-to-end convergence; these tests exercise the helpers in isolation
 * so failure modes (tombstone semantics, deterministic diff, projection
 * dedup) surface with a clear pointer.
 */
import { describe, it, expect } from 'vitest';
import {
  applyLabelDiff,
  mergeLabelMaps,
  normalizeLegacyLabelValues,
  projectLabelsToValues,
  type LabelsMap,
} from '../trackerLabels';

describe('trackerLabels', () => {
  describe('projectLabelsToValues', () => {
    it('returns unique non-tombstoned values', () => {
      const map: LabelsMap = {
        a: { id: 'a', value: 'bug' },
        b: { id: 'b', value: 'bug' }, // duplicate value
        c: { id: 'c', value: 'urgent' },
        d: { id: 'd', value: 'old', tombstone: true },
      };
      expect(projectLabelsToValues(map)).toEqual(['bug', 'urgent']);
    });

    it('returns empty array for undefined or empty map', () => {
      expect(projectLabelsToValues(undefined)).toEqual([]);
      expect(projectLabelsToValues({})).toEqual([]);
    });

    it('skips non-object / malformed entries (corrupted-map defense)', () => {
      // Reproduces the shape seen after a `data->'labelsMap'` string
      // round-trip leaked into `mergeLabelMaps` as the `local` argument:
      // {...stringJSON, ...realMap} -> hybrid character-keyed entries
      // plus the real UUID entries. The projection must skip the character
      // junk and emit only the real values, never a leading null.
      const corrupted = {
        '0': '{' as unknown as { id: string; value: string },
        '1': '"' as unknown as { id: string; value: string },
        'uuid-a': { id: 'uuid-a', value: 'editor' },
        'uuid-b': { id: 'uuid-b', value: 'lexical' },
      } as unknown as LabelsMap;
      expect(projectLabelsToValues(corrupted)).toEqual(['editor', 'lexical']);
    });
  });

  describe('applyLabelDiff', () => {
    let id = 0;
    const ids = () => `id-${++id}`;

    it('mints entries for new values', () => {
      id = 0;
      const next = applyLabelDiff(undefined, ['bug', 'urgent'], ids);
      expect(Object.keys(next)).toHaveLength(2);
      expect(projectLabelsToValues(next).sort()).toEqual(['bug', 'urgent']);
    });

    it('tombstones live entries whose value was removed', () => {
      id = 0;
      const prior: LabelsMap = {
        a: { id: 'a', value: 'bug' },
        b: { id: 'b', value: 'urgent' },
      };
      const next = applyLabelDiff(prior, ['bug'], ids);
      expect(next.a.tombstone).toBeUndefined();
      expect(next.b.tombstone).toBe(true);
      expect(projectLabelsToValues(next)).toEqual(['bug']);
    });

    it('preserves existing tombstones', () => {
      id = 0;
      const prior: LabelsMap = {
        a: { id: 'a', value: 'old', tombstone: true },
      };
      const next = applyLabelDiff(prior, ['old'], ids);
      // The prior tombstoned entry stays tombstoned; the desired "old"
      // becomes a fresh entry under a new id.
      expect(next.a.tombstone).toBe(true);
      const liveOld = Object.values(next).filter((e) => !e.tombstone && e.value === 'old');
      expect(liveOld).toHaveLength(1);
    });

    it('is a no-op when desired matches the projection', () => {
      id = 0;
      const prior: LabelsMap = { a: { id: 'a', value: 'bug' } };
      const next = applyLabelDiff(prior, ['bug'], ids);
      expect(next).toEqual(prior);
    });
  });

  describe('mergeLabelMaps', () => {
    it('unions disjoint entries from both sides', () => {
      const local: LabelsMap = { a: { id: 'a', value: 'bug' } };
      const incoming: LabelsMap = { b: { id: 'b', value: 'urgent' } };
      const merged = mergeLabelMaps(local, incoming);
      expect(projectLabelsToValues(merged).sort()).toEqual(['bug', 'urgent']);
    });

    it('remove wins by key', () => {
      const local: LabelsMap = { a: { id: 'a', value: 'bug' } };
      const incoming: LabelsMap = { a: { id: 'a', value: 'bug', tombstone: true } };
      const merged = mergeLabelMaps(local, incoming);
      expect(merged.a.tombstone).toBe(true);
    });

    it('add by different keys with the same value both survive (add-wins)', () => {
      const local: LabelsMap = { a: { id: 'a', value: 'bug' } };
      const incoming: LabelsMap = { b: { id: 'b', value: 'bug' } };
      const merged = mergeLabelMaps(local, incoming);
      expect(merged.a.tombstone).toBeUndefined();
      expect(merged.b.tombstone).toBeUndefined();
      // Projection dedupes by value -- this is the correct UI surface.
      expect(projectLabelsToValues(merged)).toEqual(['bug']);
    });

    it('handles undefined inputs', () => {
      expect(mergeLabelMaps(undefined, undefined)).toEqual({});
      expect(mergeLabelMaps({ a: { id: 'a', value: 'bug' } }, undefined)).toEqual({ a: { id: 'a', value: 'bug' } });
      expect(mergeLabelMaps(undefined, { a: { id: 'a', value: 'bug' } })).toEqual({ a: { id: 'a', value: 'bug' } });
    });
  });

  describe('normalizeLegacyLabelValues', () => {
    it('passes through a string array', () => {
      expect(normalizeLegacyLabelValues(['bug', 'urgent'])).toEqual(['bug', 'urgent']);
    });

    it('filters non-string entries out of arrays', () => {
      expect(normalizeLegacyLabelValues(['bug', 123, null, 'urgent'])).toEqual(['bug', 'urgent']);
    });

    it('parses a JSON-stringified array (legacy double-stringified rows)', () => {
      // Exactly the shape observed for the 8 backfill-failing items:
      // data.labels stored as a JSON string instead of a JSON array.
      expect(normalizeLegacyLabelValues('["editor", "lexical", "diff"]'))
        .toEqual(['editor', 'lexical', 'diff']);
    });

    it('returns undefined for non-JSON strings', () => {
      expect(normalizeLegacyLabelValues('not json')).toBeUndefined();
    });

    it('returns undefined for null/undefined', () => {
      expect(normalizeLegacyLabelValues(undefined)).toBeUndefined();
      expect(normalizeLegacyLabelValues(null)).toBeUndefined();
    });

    it('returns undefined for object inputs (would otherwise crash applyLabelDiff)', () => {
      // Defensive: a CRDT LabelsMap accidentally read out of data.labels
      // must not silently become a values array.
      expect(normalizeLegacyLabelValues({ a: { id: 'a', value: 'bug' } })).toBeUndefined();
    });

    it('output is safe to feed to applyLabelDiff for every supported input', () => {
      // Lock the contract: whatever this helper returns, applyLabelDiff
      // must accept without throwing. Regression guard against the
      // "(newValues ?? []).filter is not a function" crash.
      const inputs: unknown[] = [
        undefined,
        null,
        ['bug'],
        ['bug', 42, 'urgent'],
        '["editor", "lexical"]',
        'not json',
        { a: { id: 'a', value: 'bug' } },
      ];
      for (const raw of inputs) {
        const values = normalizeLegacyLabelValues(raw);
        expect(() => applyLabelDiff(undefined, values, () => 'id')).not.toThrow();
      }
    });
  });
});
