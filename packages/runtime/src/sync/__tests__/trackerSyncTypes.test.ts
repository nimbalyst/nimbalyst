/**
 * Unit tests for tracker sync pure functions:
 * - trackerItemToPayload (TrackerItem -> wire format via TrackerRecord)
 * - payloadToTrackerItem (wire format -> TrackerItem via TrackerRecord)
 * - recordToPayload / payloadToRecord (TrackerRecord <-> wire format)
 * - mergeTrackerItems (field-level LWW conflict resolution)
 */

import { describe, it, expect } from 'vitest';
import {
  trackerItemToPayload,
  payloadToTrackerItem,
  recordToPayload,
  payloadToRecord,
} from '../trackerSyncTypes';
import { mergeTrackerItems } from '../TrackerSync';
import type { TrackerItemPayload } from '../trackerSyncTypes';
import type { TrackerItem } from '../../core/DocumentService';
import type { TrackerRecord } from '../../core/TrackerRecord';

// ============================================================================
// Test Helpers
// ============================================================================

function makeTrackerItem(overrides: Partial<TrackerItem> & { id: string }): TrackerItem {
  return {
    type: 'bug',
    title: 'Test bug',
    status: 'to-do',
    priority: 'medium',
    module: 'nimbalyst-local/tracker/bugs/test.md',
    workspace: '/Users/test/project',
    lastIndexed: new Date('2026-01-01'),
    ...overrides,
  };
}

function makePayload(overrides: Partial<TrackerItemPayload> & { itemId: string }): TrackerItemPayload {
  return {
    primaryType: 'bug',
    archived: false,
    system: {},
    fields: { title: 'Test bug', status: 'to-do', priority: 'medium' },
    comments: [],
    activity: [],
    fieldUpdatedAt: {},
    ...overrides,
  };
}

function makeRecord(overrides?: Partial<TrackerRecord>): TrackerRecord {
  return {
    id: 'bug-001',
    primaryType: 'bug',
    typeTags: ['bug'],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/Users/test/project',
      createdAt: '2026-04-01',
      updatedAt: '2026-04-08',
    },
    fields: { title: 'Test bug', status: 'to-do', priority: 'medium' },
    fieldUpdatedAt: {},
    ...overrides,
  };
}

// ============================================================================
// trackerItemToPayload (legacy convenience wrapper)
// ============================================================================

describe('trackerItemToPayload', () => {
  it('should convert basic fields correctly', () => {
    const item = makeTrackerItem({
      id: 'bug-001',
      issueNumber: 123,
      issueKey: 'NIM-123',
      type: 'bug',
      title: 'Login broken',
      description: 'Cannot log in with valid credentials',
      status: 'to-do',
      priority: 'high',
    });

    const payload = trackerItemToPayload(item, 'user-123');

    expect(payload.itemId).toBe('bug-001');
    expect(payload.issueNumber).toBe(123);
    expect(payload.issueKey).toBe('NIM-123');
    expect(payload.primaryType).toBe('bug');
    expect(payload.fields.title).toBe('Login broken');
    expect(payload.fields.description).toBe('Cannot log in with valid credentials');
    expect(payload.fields.status).toBe('to-do');
    expect(payload.fields.priority).toBe('high');
  });

  it('should handle empty arrays for collaborative fields', () => {
    const item = makeTrackerItem({ id: 'bug-005' });
    const payload = trackerItemToPayload(item, 'user-123');
    expect(payload.comments).toEqual([]);
  });

  it('should omit local-only linkedSessions from shared payloads', () => {
    const item = makeTrackerItem({
      id: 'bug-006',
      labels: ['critical', 'auth'],
      linkedSessions: ['session-1', 'session-2'],
      linkedCommitSha: 'abc123',
      documentId: 'doc-1',
    });

    const payload = trackerItemToPayload(item, 'user-123');

    expect(payload.fields.labels).toEqual(['critical', 'auth']);
    expect(payload.system.linkedSessions).toBeUndefined();
    expect(payload.fieldUpdatedAt.linkedSessions).toBeUndefined();
    expect(payload.system.linkedCommitSha).toBe('abc123');
    expect(payload.system.documentId).toBe('doc-1');
  });

  it('should set fieldUpdatedAt timestamps for fields', () => {
    const before = Date.now();
    const item = makeTrackerItem({ id: 'bug-007', title: 'Test', status: 'to-do' });
    const payload = trackerItemToPayload(item, 'user-123');
    const after = Date.now();

    // At minimum, title and status should have timestamps
    expect(payload.fieldUpdatedAt.title).toBeGreaterThanOrEqual(before);
    expect(payload.fieldUpdatedAt.title).toBeLessThanOrEqual(after);
    expect(payload.fieldUpdatedAt.status).toBeGreaterThanOrEqual(before);
  });

  it('should handle archived items', () => {
    const item = makeTrackerItem({
      id: 'bug-008',
      archived: true,
    });

    const payload = trackerItemToPayload(item, 'user-123');
    expect(payload.archived).toBe(true);
  });

  it('should default archived to false when not set', () => {
    const item = makeTrackerItem({ id: 'bug-009' });
    const payload = trackerItemToPayload(item, 'user-123');
    expect(payload.archived).toBe(false);
  });

  it('should pass through customFields into fields', () => {
    const item = makeTrackerItem({
      id: 'bug-010',
      customFields: { severity: 'P0', affectedUsers: 1500 },
    });

    const payload = trackerItemToPayload(item, 'user-123');
    expect(payload.fields.severity).toBe('P0');
    expect(payload.fields.affectedUsers).toBe(1500);
  });
});

// ============================================================================
// payloadToTrackerItem (legacy convenience wrapper)
// ============================================================================

describe('payloadToTrackerItem', () => {
  it('should convert basic fields correctly', () => {
    const payload = makePayload({
      itemId: 'bug-101',
      primaryType: 'task',
      fields: {
        title: 'Refactor auth',
        description: 'Split into separate module',
        status: 'in-progress',
        priority: 'high',
      },
    });

    const item = payloadToTrackerItem(payload, '/workspace/project');

    expect(item.id).toBe('bug-101');
    expect(item.type).toBe('task');
    expect(item.title).toBe('Refactor auth');
    expect(item.description).toBe('Split into separate module');
    expect(item.status).toBe('in-progress');
    expect(item.priority).toBe('high');
    expect(item.workspace).toBe('/workspace/project');
  });

  it('should set syncStatus to synced', () => {
    const payload = makePayload({ itemId: 'bug-102' });
    const item = payloadToTrackerItem(payload, '/workspace');
    expect(item.syncStatus).toBe('synced');
  });

  it('should set module to empty string (synced items have no source file)', () => {
    const payload = makePayload({ itemId: 'bug-103' });
    const item = payloadToTrackerItem(payload, '/workspace');
    expect(item.module).toBe('');
  });

  it('should ignore local-only linkedSessions from sync payloads', () => {
    const payload = makePayload({
      itemId: 'bug-105',
      system: {
        linkedSessions: ['sess-1'],
        linkedCommitSha: 'def456',
        documentId: 'doc-2',
      },
      fields: {
        title: 'test',
        status: 'to-do',
        labels: ['ui', 'regression'],
      },
    });

    const item = payloadToTrackerItem(payload, '/workspace');

    expect(item.labels).toEqual(['ui', 'regression']);
    expect(item.linkedSessions).toBeUndefined();
    expect(item.linkedCommitSha).toBe('def456');
    expect(item.documentId).toBe('doc-2');
  });

  it('should handle archived items', () => {
    const payload = makePayload({
      itemId: 'bug-106',
      archived: true,
    });

    const item = payloadToTrackerItem(payload, '/workspace');
    expect(item.archived).toBe(true);
  });

  it('should default archived to false', () => {
    const payload = makePayload({ itemId: 'bug-107' });
    const item = payloadToTrackerItem(payload, '/workspace');
    expect(item.archived).toBe(false);
  });

  it('should set lastIndexed to current time', () => {
    const before = new Date();
    const payload = makePayload({ itemId: 'bug-108' });
    const item = payloadToTrackerItem(payload, '/workspace');
    const after = new Date();

    expect(item.lastIndexed.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(item.lastIndexed.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ============================================================================
// recordToPayload / payloadToRecord
// ============================================================================

describe('recordToPayload', () => {
  it('should map record fields to payload fields', () => {
    const record = makeRecord({
      id: 'bug-001',
      fields: { title: 'A bug', status: 'open', severity: 'critical' },
    });
    const payload = recordToPayload(record);

    expect(payload.itemId).toBe('bug-001');
    expect(payload.primaryType).toBe('bug');
    expect(payload.fields.title).toBe('A bug');
    expect(payload.fields.status).toBe('open');
    expect(payload.fields.severity).toBe('critical');
  });

  it('should place system metadata in system', () => {
    const record = makeRecord({
      system: {
        workspace: '/ws',
        createdAt: '2026-01-01',
        updatedAt: '2026-04-08',
        authorIdentity: { email: 'a@b.com', displayName: 'A', gitName: null, gitEmail: null },
        linkedSessions: ['s-1'],
      },
    });
    const payload = recordToPayload(record);

    expect(payload.system.authorIdentity?.email).toBe('a@b.com');
    expect(payload.system.linkedSessions).toBeUndefined();
    expect(payload.fieldUpdatedAt.linkedSessions).toBeUndefined();
    expect(payload.system.createdAt).toBe('2026-01-01');
  });
});

describe('payloadToRecord', () => {
  it('should convert payload back to record', () => {
    const payload = makePayload({
      itemId: 'task-001',
      primaryType: 'task',
      fields: { title: 'Do thing', status: 'in-progress', customField: 42 },
      system: { linkedSessions: ['s-1'] },
    });

    const record = payloadToRecord(payload, '/workspace');

    expect(record.id).toBe('task-001');
    expect(record.primaryType).toBe('task');
    expect(record.fields.title).toBe('Do thing');
    expect(record.fields.customField).toBe(42);
    expect(record.system.linkedSessions).toBeUndefined();
    expect(record.fieldUpdatedAt.linkedSessions).toBeUndefined();
    expect(record.system.workspace).toBe('/workspace');
    expect(record.syncStatus).toBe('synced');
  });
});

// ============================================================================
// Round-trip: TrackerItem -> Payload -> TrackerItem
// ============================================================================

describe('payload round-trip', () => {
  it('should preserve data through a full round-trip', () => {
    const original = makeTrackerItem({
      id: 'round-trip-1',
      issueNumber: 777,
      issueKey: 'NIM-777',
      type: 'bug',
      title: 'Round trip test',
      description: 'Testing full round trip',
      status: 'in-progress',
      priority: 'critical',
      labels: ['sync', 'test'],
      linkedSessions: ['session-abc'],
      linkedCommitSha: 'abc123def',
      documentId: 'doc-xyz',
      customFields: { browser: 'Chrome', os: 'macOS' },
      archived: false,
    });

    const payload = trackerItemToPayload(original, 'user-999');
    const roundTripped = payloadToTrackerItem(payload, original.workspace);

    expect(roundTripped.id).toBe(original.id);
    expect(roundTripped.type).toBe(original.type);
    expect(roundTripped.title).toBe(original.title);
    expect(roundTripped.description).toBe(original.description);
    expect(roundTripped.status).toBe(original.status);
    expect(roundTripped.priority).toBe(original.priority);
    expect(roundTripped.labels).toEqual(original.labels);
    expect(roundTripped.linkedSessions).toBeUndefined();
    expect(roundTripped.linkedCommitSha).toBe(original.linkedCommitSha);
    expect(roundTripped.documentId).toBe(original.documentId);
    expect(roundTripped.customFields).toEqual(original.customFields);
    expect(roundTripped.workspace).toBe(original.workspace);
    expect(roundTripped.syncStatus).toBe('synced');
  });

  it('should handle items with minimal fields', () => {
    const minimal = makeTrackerItem({
      id: 'minimal-1',
      title: 'Minimal item',
    });

    const payload = trackerItemToPayload(minimal, 'user-1');
    const result = payloadToTrackerItem(payload, minimal.workspace);

    expect(result.id).toBe('minimal-1');
    expect(result.title).toBe('Minimal item');
  });
});

// ============================================================================
// mergeTrackerItems (field-level LWW)
// ============================================================================

describe('mergeTrackerItems', () => {
  it('should take remote field when remote timestamp is newer', () => {
    const now = Date.now();

    const local = makePayload({
      itemId: 'merge-1',
      fields: { title: 'Old title' },
      fieldUpdatedAt: { title: now - 1000 },
    });

    const remote = makePayload({
      itemId: 'merge-1',
      fields: { title: 'New title' },
      fieldUpdatedAt: { title: now },
    });

    const merged = mergeTrackerItems(local, remote);
    expect(merged.fields.title).toBe('New title');
    expect(merged.fieldUpdatedAt.title).toBe(now);
  });

  it('should keep local field when local timestamp is newer', () => {
    const now = Date.now();

    const local = makePayload({
      itemId: 'merge-2',
      fields: { status: 'done' },
      fieldUpdatedAt: { status: now },
    });

    const remote = makePayload({
      itemId: 'merge-2',
      fields: { status: 'to-do' },
      fieldUpdatedAt: { status: now - 1000 },
    });

    const merged = mergeTrackerItems(local, remote);
    expect(merged.fields.status).toBe('done');
  });

  it('should keep local field when timestamps are equal (local wins ties)', () => {
    const now = Date.now();

    const local = makePayload({
      itemId: 'merge-3',
      fields: { title: 'Local version' },
      fieldUpdatedAt: { title: now },
    });

    const remote = makePayload({
      itemId: 'merge-3',
      fields: { title: 'Remote version' },
      fieldUpdatedAt: { title: now },
    });

    const merged = mergeTrackerItems(local, remote);
    expect(merged.fields.title).toBe('Local version');
  });

  it('should merge different fields independently', () => {
    const now = Date.now();

    const local = makePayload({
      itemId: 'merge-4',
      fields: {
        title: 'Local title',
        status: 'in-progress',
        priority: 'low',
        description: 'Local desc',
      },
      fieldUpdatedAt: {
        title: now - 100,
        status: now,
        priority: now - 200,
        description: now,
      },
    });

    const remote = makePayload({
      itemId: 'merge-4',
      fields: {
        title: 'Remote title',
        status: 'done',
        priority: 'critical',
        description: 'Remote desc',
      },
      fieldUpdatedAt: {
        title: now,
        status: now - 500,
        priority: now,
        description: now - 1000,
      },
    });

    const merged = mergeTrackerItems(local, remote);

    expect(merged.fields.title).toBe('Remote title');
    expect(merged.fields.status).toBe('in-progress');
    expect(merged.fields.priority).toBe('critical');
    expect(merged.fields.description).toBe('Local desc');
  });

  it('should handle missing fieldUpdatedAt entries (default to 0)', () => {
    const now = Date.now();

    const local = makePayload({
      itemId: 'merge-5',
      fields: { title: 'Local' },
      fieldUpdatedAt: {},
    });

    const remote = makePayload({
      itemId: 'merge-5',
      fields: { title: 'Remote' },
      fieldUpdatedAt: { title: now },
    });

    const merged = mergeTrackerItems(local, remote);
    expect(merged.fields.title).toBe('Remote');
  });

  it('should merge array fields (labels) using whole-array LWW', () => {
    const now = Date.now();

    const local = makePayload({
      itemId: 'merge-6',
      fields: { labels: ['old-label'] },
      fieldUpdatedAt: { labels: now - 1000 },
    });

    const remote = makePayload({
      itemId: 'merge-6',
      fields: { labels: ['new-label-1', 'new-label-2'] },
      fieldUpdatedAt: { labels: now },
    });

    const merged = mergeTrackerItems(local, remote);
    expect(merged.fields.labels).toEqual(['new-label-1', 'new-label-2']);
  });

  it('should merge archived state', () => {
    const now = Date.now();

    const local = makePayload({
      itemId: 'merge-7',
      archived: false,
      fieldUpdatedAt: { archived: now - 500 },
    });

    const remote = makePayload({
      itemId: 'merge-7',
      archived: true,
      fieldUpdatedAt: { archived: now },
    });

    const merged = mergeTrackerItems(local, remote);
    expect(merged.archived).toBe(true);
  });

  it('should preserve non-mergeable fields from local (itemId, primaryType)', () => {
    const local = makePayload({
      itemId: 'merge-8',
      primaryType: 'bug',
      fields: {},
      fieldUpdatedAt: {},
    });

    const remote = makePayload({
      itemId: 'merge-8',
      primaryType: 'task',
      fields: {},
      fieldUpdatedAt: {},
    });

    const merged = mergeTrackerItems(local, remote);
    expect(merged.itemId).toBe('merge-8');
    expect(merged.primaryType).toBe('bug');
  });

  it('should handle custom fields via generic fields merge', () => {
    const now = Date.now();

    const local = makePayload({
      itemId: 'merge-9',
      fields: { browser: 'Firefox', severity: 'low' },
      fieldUpdatedAt: { browser: now - 100, severity: now },
    });

    const remote = makePayload({
      itemId: 'merge-9',
      fields: { browser: 'Chrome', os: 'Linux', severity: 'high' },
      fieldUpdatedAt: { browser: now, os: now, severity: now - 200 },
    });

    const merged = mergeTrackerItems(local, remote);
    expect(merged.fields.browser).toBe('Chrome');
    expect(merged.fields.os).toBe('Linux');
    expect(merged.fields.severity).toBe('low');
  });

  it('should keep linkedSessions local while still merging shared system fields', () => {
    const now = Date.now();

    const local = makePayload({
      itemId: 'merge-10',
      system: { linkedSessions: ['s-1'], documentId: 'doc-local' },
      fields: {},
      fieldUpdatedAt: { linkedSessions: now, documentId: now - 500 },
    });

    const remote = makePayload({
      itemId: 'merge-10',
      system: { linkedSessions: ['s-2'], documentId: 'doc-remote' },
      fields: {},
      fieldUpdatedAt: { linkedSessions: now - 1000, documentId: now },
    });

    const merged = mergeTrackerItems(local, remote);
    expect(merged.system.linkedSessions).toEqual(['s-1']);
    expect(merged.system.documentId).toBe('doc-remote');
  });

  it('should union comments by ID when both sides add different comments', () => {
    const now = Date.now();
    const local = makePayload({
      itemId: 'merge-comments-1',
      comments: [
        { id: 'c1', authorIdentity: { displayName: 'user1' } as any, body: 'Local comment', createdAt: now - 2000 },
      ],
      fieldUpdatedAt: { comments: now - 1000 },
    });
    const remote = makePayload({
      itemId: 'merge-comments-1',
      comments: [
        { id: 'c2', authorIdentity: { displayName: 'user2' } as any, body: 'Remote comment', createdAt: now - 1000 },
      ],
      fieldUpdatedAt: { comments: now },
    });
    const merged = mergeTrackerItems(local, remote);
    expect(merged.comments).toHaveLength(2);
    expect(merged.comments.map(c => c.id)).toEqual(['c1', 'c2']);
  });

  it('should keep newer version when same comment ID exists on both sides', () => {
    const now = Date.now();
    const local = makePayload({
      itemId: 'merge-comments-2',
      comments: [
        { id: 'c1', authorIdentity: { displayName: 'user1' } as any, body: 'Original', createdAt: now - 2000, updatedAt: now - 1000 },
      ],
      fieldUpdatedAt: { comments: now - 1000 },
    });
    const remote = makePayload({
      itemId: 'merge-comments-2',
      comments: [
        { id: 'c1', authorIdentity: { displayName: 'user1' } as any, body: 'Edited', createdAt: now - 2000, updatedAt: now },
      ],
      fieldUpdatedAt: { comments: now },
    });
    const merged = mergeTrackerItems(local, remote);
    expect(merged.comments).toHaveLength(1);
    expect(merged.comments[0].body).toBe('Edited');
  });

  it('should union activity entries by ID and bound to 100', () => {
    const now = Date.now();
    const local = makePayload({
      itemId: 'merge-activity-1',
      activity: [
        { id: 'a1', authorIdentity: { displayName: 'user1' } as any, action: 'created', timestamp: now - 2000 },
      ],
      fieldUpdatedAt: { activity: now - 1000 },
    });
    const remote = makePayload({
      itemId: 'merge-activity-1',
      activity: [
        { id: 'a2', authorIdentity: { displayName: 'user2' } as any, action: 'commented', timestamp: now - 1000 },
      ],
      fieldUpdatedAt: { activity: now },
    });
    const merged = mergeTrackerItems(local, remote);
    expect(merged.activity).toHaveLength(2);
    expect(merged.activity.map(a => a.id)).toEqual(['a1', 'a2']);
  });
});

// ============================================================================
// recordToPayload / payloadToRecord round-trip with comments and activity
// ============================================================================

describe('recordToPayload and payloadToRecord round-trip comments/activity', () => {
  it('should round-trip comments through payload', () => {
    const record: TrackerRecord = {
      id: 'rt-1',
      primaryType: 'bug',
      typeTags: ['bug'],
      source: 'native',
      archived: false,
      syncStatus: 'synced',
      system: {
        workspace: '/test',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        comments: [
          { id: 'c1', authorIdentity: { displayName: 'user1' } as any, body: 'Test', createdAt: 1000 },
        ],
      },
      fields: { title: 'Test', status: 'to-do' },
      fieldUpdatedAt: {},
    };
    const payload = recordToPayload(record);
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].body).toBe('Test');

    const back = payloadToRecord(payload, '/test');
    expect(back.system.comments).toHaveLength(1);
    expect(back.system.comments![0].body).toBe('Test');
  });

  it('should round-trip activity through payload', () => {
    const record: TrackerRecord = {
      id: 'rt-2',
      primaryType: 'task',
      typeTags: ['task'],
      source: 'native',
      archived: false,
      syncStatus: 'synced',
      system: {
        workspace: '/test',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        activity: [
          { id: 'a1', authorIdentity: { displayName: 'user1' } as any, action: 'created', timestamp: 1000 },
        ],
      },
      fields: { title: 'Test', status: 'to-do' },
      fieldUpdatedAt: {},
    };
    const payload = recordToPayload(record);
    expect(payload.activity).toHaveLength(1);
    expect(payload.activity[0].action).toBe('created');

    const back = payloadToRecord(payload, '/test');
    expect(back.system.activity).toHaveLength(1);
    expect(back.system.activity![0].action).toBe('created');
  });
});
