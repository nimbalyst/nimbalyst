import { describe, it, expect } from 'vitest';
import { recordToDbParams } from '@nimbalyst/runtime/core/TrackerRecord';
import { payloadToRecord } from '../TrackerPGLiteStore';
import type { TrackerItemPayload, EncryptedTrackerItemEnvelope } from '@nimbalyst/runtime/sync';

/**
 * Regression: an imported item's `data.origin` was dropped the first time the
 * optimistic local apply rebuilt `data` from the wire payload, because
 * `payloadToRecord` did not carry `system.origin` (and `trackerItemToPayload`
 * did not put it on the payload). With origin gone, the
 * `data->'origin'->'external'->>'urn'` index was empty and the importer could
 * not resolve its own URN. These assert origin survives payload -> record ->
 * db `data`.
 */
const ORIGIN = {
  kind: 'external' as const,
  external: {
    providerId: 'github-issues',
    externalId: 'owner/repo#42',
    urn: 'github://owner/repo#42',
    url: 'https://github.com/owner/repo/issues/42',
    titleSnapshot: 'Some issue',
    stateSnapshot: 'open',
    importedAt: '2026-06-07T00:00:00.000Z',
    lastSyncedAt: '2026-06-07T00:00:00.000Z',
  },
};

function makeEnvelope(itemId: string): EncryptedTrackerItemEnvelope {
  return {
    itemId,
    syncId: 1,
    encryptedPayload: 'x',
    iv: 'iv',
    updatedAt: 0,
    deletedAt: null,
    orgKeyFingerprint: null,
  };
}

function makePayload(): TrackerItemPayload {
  return {
    itemId: 'ext_abc',
    primaryType: 'feature',
    archived: false,
    issueNumber: 7,
    issueKey: 'NIM-7',
    bodyVersion: 0,
    fields: { title: 'Imported', status: 'to-do' },
    labels: {},
    comments: [],
    system: {
      authorIdentity: null,
      lastModifiedBy: null,
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: '2026-06-07T00:00:00.000Z',
      origin: ORIGIN,
    },
  };
}

describe('payload origin round-trip', () => {
  it('payloadToRecord carries system.origin', () => {
    const record = payloadToRecord(makeEnvelope('ext_abc'), makePayload(), '/ws');
    expect(record.system.origin).toEqual(ORIGIN);
  });

  it('recordToDbParams persists data.origin (so the URN index is populated)', () => {
    const record = payloadToRecord(makeEnvelope('ext_abc'), makePayload(), '/ws');
    const { data } = recordToDbParams(record);
    const parsed = JSON.parse(data);
    expect(parsed.origin).toEqual(ORIGIN);
    expect(parsed.origin.external.urn).toBe('github://owner/repo#42');
  });
});

/**
 * `triagedAt` retires an item from the triage inbox, and it is shared rather
 * than personal, so it has to survive the same payload -> record -> `data`
 * path as `origin`. A system key that isn't carried by every converter is
 * dropped silently: the item disappears from the inbox until the next sync
 * apply rebuilds `data`, then reappears (NIM-2172).
 */
describe('payload triagedAt round-trip', () => {
  const TRIAGED_AT = '2026-07-25T12:00:00.000Z';
  const TRIAGED_BY = {
    displayName: 'Greg',
    email: 'greg@example.com',
    gitName: 'Greg',
    gitEmail: 'greg@example.com',
  };

  function triagedPayload(): TrackerItemPayload {
    const base = makePayload();
    return { ...base, system: { ...base.system, triagedAt: TRIAGED_AT, triagedBy: TRIAGED_BY } };
  }

  it('payloadToRecord carries system.triagedAt', () => {
    const record = payloadToRecord(makeEnvelope('ext_abc'), triagedPayload(), '/ws');
    expect(record.system.triagedAt).toBe(TRIAGED_AT);
    expect(record.system.triagedBy).toEqual(TRIAGED_BY);
  });

  it('recordToDbParams persists data.triagedAt', () => {
    const record = payloadToRecord(makeEnvelope('ext_abc'), triagedPayload(), '/ws');
    const parsed = JSON.parse(recordToDbParams(record).data);
    expect(parsed.triagedAt).toBe(TRIAGED_AT);
    expect(parsed.triagedBy).toEqual(TRIAGED_BY);
    // It is system metadata, not a schema field, so it must not leak into the
    // grid as a user-editable column.
    expect(record.fields.triagedAt).toBeUndefined();
  });
});

describe('payload system collection round-trip', () => {
  it('carries comments, activity, and pull request links into the canonical record', () => {
    const comments = [
      { id: 'comment-1', authorIdentity: { displayName: 'Alice' }, body: 'hello', createdAt: 1 },
    ];
    const activity = [
      { id: 'activity-1', authorIdentity: { displayName: 'Alice' }, action: 'commented', timestamp: 1 },
    ];
    const linkedPullRequests = [
      { remote: 'nimbalyst/nimbalyst', number: 42 },
    ];
    const payload = {
      ...makePayload(),
      comments,
      activity,
      system: {
        ...makePayload().system,
        linkedPullRequests,
      },
    } as TrackerItemPayload;

    const record = payloadToRecord(makeEnvelope('ext_abc'), payload, '/ws');

    expect(record.system.comments).toEqual(comments);
    expect(record.system.activity).toEqual(activity);
    expect(record.system.linkedPullRequests).toEqual(linkedPullRequests);
  });
});
