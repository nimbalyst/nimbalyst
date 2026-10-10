// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_TRACKER_ITEM_PAYLOAD_BYTES } from '@nimbalyst/collab-protocol';
import { capActivityValue, MAX_ACTIVITY_VALUE_CHARS } from '@nimbalyst/tracker-core';
import { decodeTrackerEnvelopePlaintext, encodeTrackerPayloadPlaintext } from '@nimbalyst/tracker-engine';
import type { TrackerItemPayload } from '@nimbalyst/runtime/sync';
import { appendActivity, mergeActivity } from '../trackerActivity';

describe('appendActivity', () => {
  it('migrates legacy nested activity before appending', () => {
    const data: Record<string, any> = {
      customFields: {
        activity: [{ id: 'old', authorIdentity: { displayName: 'Alice' }, action: 'created', timestamp: 1 }],
        sibling: 'keep',
      },
    };

    appendActivity(data, { displayName: 'Alice' }, 'commented');

    expect(data.activity).toHaveLength(2);
    expect(data.activity[0].id).toBe('old');
    expect(data.activity[1].action).toBe('commented');
    expect(data.customFields).toEqual({ sibling: 'keep' });
  });
});

describe('mergeActivity', () => {
  // The wire copy of an oversized item caps activity values. When the room
  // echoes that copy back, the local trail must keep its full values.
  it('keeps the full local value when the echo carries the wire-trimmed form', () => {
    const fullOld = 'o'.repeat(2_000);
    const fullNew = 'n'.repeat(2_000);
    const local: TrackerItemPayload = {
      itemId: 'plan-1',
      primaryType: 'plan',
      archived: false,
      bodyVersion: 0,
      fields: { title: 'Plan', description: 'd'.repeat(MAX_TRACKER_ITEM_PAYLOAD_BYTES - 3_000) },
      labels: {},
      comments: [],
      system: {},
      activity: [{
        id: 'activity_1',
        authorIdentity: { email: 'a@example.com', displayName: 'A', gitName: null, gitEmail: null },
        action: 'updated',
        field: 'description',
        oldValue: fullOld,
        newValue: fullNew,
        timestamp: 1,
      }, {
        id: 'activity_2',
        authorIdentity: { email: 'a@example.com', displayName: 'A', gitName: null, gitEmail: null },
        action: 'updated',
        field: 'priority',
        oldValue: 'low',
        newValue: 'high',
        timestamp: 2,
      }],
    };

    const sent = encodeTrackerPayloadPlaintext(local);
    const echoed = decodeTrackerEnvelopePlaintext({
      itemId: 'plan-1',
      syncId: 1,
      encryptedPayload: sent,
      iv: '',
      updatedAt: 1,
      deletedAt: null,
      orgKeyFingerprint: null,
    });
    expect(echoed.activity?.[0].oldValue?.length).toBeLessThan(fullOld.length);

    const merged = mergeActivity(local.activity, echoed.activity) ?? [];
    expect(merged.map(entry => [entry.id, entry.oldValue?.length, entry.newValue?.length])).toEqual([
      ['activity_1', fullOld.length, fullNew.length],
      ['activity_2', 3, 4],
    ]);
    expect(merged[0]).toMatchObject({ oldValue: fullOld, newValue: fullNew });
  });

  // Coalescing keeps the entry id. A later edit that shares the first 499
  // characters caps to the same value, and must not bring back the old tail.
  it('takes the incoming value when the entry was coalesced into a newer edit', () => {
    const entry = (newValue: string, timestamp: number) => ({
      id: 'activity_1',
      authorIdentity: { email: 'a@example.com', displayName: 'A', gitName: null, gitEmail: null },
      action: 'updated' as const,
      field: 'description',
      newValue,
      timestamp,
    });
    const prefix = 'p'.repeat(MAX_ACTIVITY_VALUE_CHARS);
    const older = entry(`${prefix}old tail`, 1);
    const newer = entry(capActivityValue(`${prefix}new tail`)!, 2);

    const [merged] = mergeActivity([older], [newer]) ?? [];

    expect(merged).toMatchObject({ newValue: newer.newValue, timestamp: 2 });
  });
});
