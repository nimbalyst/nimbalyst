/**
 * Unit tests for the labels CRDT helpers in `trackerLabels.ts`.
 *
 * The integration test in `TrackerSyncEngine.integration.test.ts` proves
 * end-to-end convergence; these tests exercise the helpers in isolation
 * so failure modes (tombstone semantics, deterministic diff, projection
 * dedup) surface with a clear pointer.
 */
import { describe, it, expect } from 'vitest';
import { applyLabelDiff, mergeLabelMaps, projectLabelsToValues, type LabelsMap } from '../trackerLabels';

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
});
