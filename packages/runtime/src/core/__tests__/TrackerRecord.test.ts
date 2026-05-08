import { describe, it, expect } from 'vitest';
import {
  trackerItemToRecord,
  trackerRecordToItem,
  dbRowToRecord,
  recordToDbParams,
  type TrackerRecord,
} from '../TrackerRecord';
import type { TrackerItem } from '../DocumentService';

function makeTrackerItem(overrides?: Partial<TrackerItem>): TrackerItem {
  return {
    id: 'bug_123',
    type: 'bug',
    typeTags: ['bug', 'task'],
    issueNumber: 42,
    issueKey: 'NIM-42',
    title: 'Fix crash on startup',
    description: 'App crashes when opening',
    status: 'in-progress',
    priority: 'high',
    owner: 'alice',
    module: 'src/main.ts',
    lineNumber: 10,
    workspace: '/projects/nimbalyst',
    tags: ['critical', 'regression'],
    created: '2026-04-01',
    updated: '2026-04-08',
    dueDate: '2026-04-15',
    progress: 50,
    lastIndexed: new Date('2026-04-08T12:00:00Z'),
    content: { type: 'doc', content: [] },
    archived: false,
    source: 'native',
    sourceRef: undefined,
    authorIdentity: { email: 'alice@example.com', displayName: 'Alice', gitName: 'alice', gitEmail: 'alice@example.com' },
    lastModifiedBy: null,
    createdByAgent: true,
    assigneeEmail: 'bob@example.com',
    reporterEmail: 'alice@example.com',
    labels: ['ui', 'critical'],
    linkedSessions: ['session-1'],
    linkedCommitSha: 'abc123',
    documentId: 'doc-1',
    syncStatus: 'synced',
    customFields: { severity: 'high', component: 'renderer' },
    ...overrides,
  };
}

describe('trackerItemToRecord', () => {
  it('moves business fields into fields bag', () => {
    const item = makeTrackerItem();
    const record = trackerItemToRecord(item);

    expect(record.fields.title).toBe('Fix crash on startup');
    expect(record.fields.status).toBe('in-progress');
    expect(record.fields.priority).toBe('high');
    expect(record.fields.owner).toBe('alice');
    expect(record.fields.description).toBe('App crashes when opening');
    expect(record.fields.tags).toEqual(['critical', 'regression']);
    expect(record.fields.dueDate).toBe('2026-04-15');
    expect(record.fields.progress).toBe(50);
    expect(record.fields.assigneeEmail).toBe('bob@example.com');
    expect(record.fields.reporterEmail).toBe('alice@example.com');
    expect(record.fields.labels).toEqual(['ui', 'critical']);
  });

  it('merges customFields into fields', () => {
    const item = makeTrackerItem();
    const record = trackerItemToRecord(item);

    expect(record.fields.severity).toBe('high');
    expect(record.fields.component).toBe('renderer');
  });

  it('places system metadata in system', () => {
    const item = makeTrackerItem();
    const record = trackerItemToRecord(item);

    expect(record.system.workspace).toBe('/projects/nimbalyst');
    expect(record.system.documentPath).toBe('src/main.ts');
    expect(record.system.lineNumber).toBe(10);
    expect(record.system.authorIdentity?.email).toBe('alice@example.com');
    expect(record.system.createdByAgent).toBe(true);
    expect(record.system.linkedSessions).toEqual(['session-1']);
    expect(record.system.linkedCommitSha).toBe('abc123');
    expect(record.system.documentId).toBe('doc-1');
  });

  it('sets top-level routing fields', () => {
    const item = makeTrackerItem();
    const record = trackerItemToRecord(item);

    expect(record.id).toBe('bug_123');
    expect(record.primaryType).toBe('bug');
    expect(record.typeTags).toEqual(['bug', 'task']);
    expect(record.issueNumber).toBe(42);
    expect(record.issueKey).toBe('NIM-42');
    expect(record.source).toBe('native');
    expect(record.archived).toBe(false);
    expect(record.syncStatus).toBe('synced');
    expect(record.content).toEqual({ type: 'doc', content: [] });
  });

  it('generates fieldUpdatedAt for every field key', () => {
    const item = makeTrackerItem();
    const record = trackerItemToRecord(item);

    for (const key of Object.keys(record.fields)) {
      expect(record.fieldUpdatedAt[key]).toBeTypeOf('number');
    }
  });
});

describe('trackerRecordToItem round-trip', () => {
  it('preserves key business fields', () => {
    const original = makeTrackerItem();
    const record = trackerItemToRecord(original);
    const restored = trackerRecordToItem(record);

    expect(restored.id).toBe(original.id);
    expect(restored.type).toBe(original.type);
    expect(restored.title).toBe(original.title);
    expect(restored.status).toBe(original.status);
    expect(restored.priority).toBe(original.priority);
    expect(restored.owner).toBe(original.owner);
    expect(restored.description).toBe(original.description);
    expect(restored.tags).toEqual(original.tags);
    expect(restored.dueDate).toBe(original.dueDate);
    expect(restored.progress).toBe(original.progress);
    expect(restored.assigneeEmail).toBe(original.assigneeEmail);
    expect(restored.reporterEmail).toBe(original.reporterEmail);
    expect(restored.labels).toEqual(original.labels);
    expect(restored.workspace).toBe(original.workspace);
    expect(restored.syncStatus).toBe(original.syncStatus);
  });

  it('preserves system metadata', () => {
    const original = makeTrackerItem();
    const record = trackerItemToRecord(original);
    const restored = trackerRecordToItem(record);

    expect(restored.authorIdentity?.email).toBe(original.authorIdentity?.email);
    expect(restored.createdByAgent).toBe(original.createdByAgent);
    expect(restored.linkedSessions).toEqual(original.linkedSessions);
    expect(restored.linkedCommitSha).toBe(original.linkedCommitSha);
    expect(restored.documentId).toBe(original.documentId);
  });

  it('preserves custom fields in customFields', () => {
    const original = makeTrackerItem();
    const record = trackerItemToRecord(original);
    const restored = trackerRecordToItem(record);

    expect(restored.customFields?.severity).toBe('high');
    expect(restored.customFields?.component).toBe('renderer');
  });
});

describe('dbRowToRecord', () => {
  it('converts a PGLite row to TrackerRecord', () => {
    const row = {
      id: 'task_456',
      type: 'task',
      type_tags: ['task'],
      data: {
        title: 'Write tests',
        status: 'to-do',
        priority: 'medium',
        owner: 'bob',
        authorIdentity: { email: 'bob@example.com', displayName: 'Bob', gitName: null, gitEmail: null },
        linkedSessions: ['s-1'],
        created: '2026-04-01',
        updated: '2026-04-08',
        customMetric: 42,
      },
      workspace: '/projects/test',
      document_path: '',
      line_number: null,
      created: new Date('2026-04-01'),
      updated: new Date('2026-04-08'),
      last_indexed: new Date('2026-04-08'),
      issue_number: null,
      issue_key: null,
      content: null,
      archived: false,
      source: 'native',
      source_ref: null,
      sync_status: 'local',
    };

    const record = dbRowToRecord(row);

    expect(record.id).toBe('task_456');
    expect(record.primaryType).toBe('task');
    expect(record.typeTags).toEqual(['task']);
    expect(record.fields.title).toBe('Write tests');
    expect(record.fields.status).toBe('to-do');
    expect(record.fields.priority).toBe('medium');
    expect(record.fields.owner).toBe('bob');
    expect(record.fields.customMetric).toBe(42);
    // System fields should NOT be in fields
    expect(record.fields.authorIdentity).toBeUndefined();
    expect(record.fields.linkedSessions).toBeUndefined();
    // System fields should be in system
    expect(record.system.authorIdentity?.email).toBe('bob@example.com');
    expect(record.system.linkedSessions).toEqual(['s-1']);
    expect(record.system.workspace).toBe('/projects/test');
  });

  it('handles stringified data', () => {
    const row = {
      id: 'x',
      type: 'bug',
      type_tags: [],
      data: JSON.stringify({ title: 'Stringified', status: 'open' }),
      workspace: '/ws',
      document_path: '',
      line_number: null,
      created: new Date(),
      updated: new Date(),
      last_indexed: new Date(),
      issue_number: null,
      issue_key: null,
      content: null,
      archived: false,
      source: 'native',
      source_ref: null,
      sync_status: 'local',
    };

    const record = dbRowToRecord(row);
    expect(record.fields.title).toBe('Stringified');
    expect(record.fields.status).toBe('open');
  });

  it('falls back to [type] when type_tags is empty', () => {
    const row = {
      id: 'x',
      type: 'idea',
      type_tags: [],
      data: { title: 'Cool idea' },
      workspace: '/ws',
      document_path: '',
      line_number: null,
      created: new Date(),
      updated: new Date(),
      last_indexed: new Date(),
      issue_number: null,
      issue_key: null,
      content: null,
      archived: false,
      source: 'native',
      source_ref: null,
      sync_status: 'local',
    };

    const record = dbRowToRecord(row);
    expect(record.typeTags).toEqual(['idea']);
  });
});

describe('recordToDbParams', () => {
  it('produces correct SQL params', () => {
    const record: TrackerRecord = {
      id: 'bug_789',
      primaryType: 'bug',
      typeTags: ['bug'],
      issueNumber: 10,
      issueKey: 'NIM-10',
      source: 'native',
      sourceRef: undefined,
      archived: false,
      syncStatus: 'local',
      content: 'some content',
      system: {
        workspace: '/ws',
        documentPath: 'src/foo.ts',
        lineNumber: 5,
        createdAt: '2026-04-01',
        updatedAt: '2026-04-08',
        authorIdentity: { email: 'a@b.com', displayName: 'A', gitName: null, gitEmail: null },
        linkedSessions: ['s-1'],
      },
      fields: {
        title: 'Test bug',
        status: 'open',
        customField: 'value',
      },
      fieldUpdatedAt: { title: 1, status: 1, customField: 1 },
    };

    const params = recordToDbParams(record);

    expect(params.id).toBe('bug_789');
    expect(params.type).toBe('bug');
    expect(params.typeTags).toEqual(['bug']);
    expect(params.workspace).toBe('/ws');
    expect(params.documentPath).toBe('src/foo.ts');
    expect(params.lineNumber).toBe(5);
    expect(params.syncStatus).toBe('local');
    expect(params.archived).toBe(false);
    expect(params.source).toBe('native');

    const data = JSON.parse(params.data);
    expect(data.title).toBe('Test bug');
    expect(data.status).toBe('open');
    expect(data.customField).toBe('value');
    expect(data.authorIdentity.email).toBe('a@b.com');
    expect(data.linkedSessions).toEqual(['s-1']);
    expect(data.created).toBe('2026-04-01');
    expect(data.updated).toBe('2026-04-08');
  });

  it('omits null/undefined system fields from data', () => {
    const record: TrackerRecord = {
      id: 'x',
      primaryType: 'task',
      typeTags: ['task'],
      source: 'native',
      archived: false,
      syncStatus: 'local',
      system: {
        workspace: '/ws',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
      fields: { title: 'Minimal' },
      fieldUpdatedAt: { title: 1 },
    };

    const params = recordToDbParams(record);
    const data = JSON.parse(params.data);

    expect(data.authorIdentity).toBeUndefined();
    expect(data.linkedSessions).toBeUndefined();
    expect(data.documentId).toBeUndefined();
  });

  it('should preserve comments in JSONB data', () => {
    const record: TrackerRecord = {
      id: 'comments-test',
      primaryType: 'bug',
      typeTags: ['bug'],
      source: 'native',
      archived: false,
      syncStatus: 'local',
      system: {
        workspace: '/ws',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        comments: [
          { id: 'c1', authorIdentity: { displayName: 'user1' } as any, body: 'Test comment', createdAt: 1000 },
        ],
      },
      fields: { title: 'Bug with comments' },
      fieldUpdatedAt: { title: 1 },
    };

    const params = recordToDbParams(record);
    const data = JSON.parse(params.data);
    expect(data.comments).toHaveLength(1);
    expect(data.comments[0].body).toBe('Test comment');
  });
});

describe('trackerItemToRecord comments/activity via customFields', () => {
  it('should pull comments from customFields into system', () => {
    const item: TrackerItem = {
      id: 'cf-test',
      type: 'bug',
      title: 'Test',
      status: 'to-do',
      module: '',
      workspace: '/ws',
      lastIndexed: new Date(),
      customFields: {
        comments: [{ id: 'c1', authorIdentity: { displayName: 'u1' }, body: 'hi', createdAt: 1 }],
        activity: [{ id: 'a1', authorIdentity: { displayName: 'u1' }, action: 'created', timestamp: 1 }],
      },
    };
    const record = trackerItemToRecord(item);
    expect(record.system.comments).toHaveLength(1);
    expect(record.system.comments![0].body).toBe('hi');
    expect(record.system.activity).toHaveLength(1);
    expect(record.system.activity![0].action).toBe('created');
  });
});

// Regression coverage for NIM-246: field-level LWW must round-trip through PGLite.
describe('fieldUpdatedAt persistence round-trip', () => {
  it('recordToDbParams writes _fieldUpdatedAt into the JSONB data column', () => {
    const record: TrackerRecord = {
      id: 'lww-1',
      primaryType: 'bug',
      typeTags: ['bug'],
      source: 'native',
      archived: false,
      syncStatus: 'local',
      system: { workspace: '/ws', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
      fields: { title: 'A', status: 'to-do' },
      fieldUpdatedAt: { title: 1700000000000, status: 1700000000500 },
    };

    const params = recordToDbParams(record);
    const data = JSON.parse(params.data);

    expect(data._fieldUpdatedAt).toEqual({
      title: 1700000000000,
      status: 1700000000500,
    });
  });

  it('dbRowToRecord reads persisted timestamps instead of stamping "now"', () => {
    const row = {
      id: 'lww-2',
      type: 'bug',
      type_tags: ['bug'],
      data: {
        title: 'A',
        status: 'in-progress',
        _fieldUpdatedAt: { title: 1700000000000, status: 1700000000500 },
      },
      workspace: '/ws',
      document_path: '',
      line_number: null,
      created: new Date('2026-01-01'),
      updated: new Date('2026-01-02'),
      last_indexed: new Date('2026-01-02'),
      issue_number: null,
      issue_key: null,
      content: null,
      archived: false,
      source: 'native',
      source_ref: null,
      sync_status: 'synced',
    };

    const record = dbRowToRecord(row);

    expect(record.fieldUpdatedAt.title).toBe(1700000000000);
    expect(record.fieldUpdatedAt.status).toBe(1700000000500);
    // _fieldUpdatedAt itself must not leak into user fields
    expect(record.fields._fieldUpdatedAt).toBeUndefined();
  });

  it('falls back to "now" for fields with no persisted timestamp (back-compat)', () => {
    const before = Date.now();
    const row = {
      id: 'lww-3',
      type: 'bug',
      type_tags: ['bug'],
      data: { title: 'A', status: 'to-do' }, // no _fieldUpdatedAt -- legacy row
      workspace: '/ws',
      document_path: '',
      line_number: null,
      created: new Date(),
      updated: new Date(),
      last_indexed: new Date(),
      issue_number: null,
      issue_key: null,
      content: null,
      archived: false,
      source: 'native',
      source_ref: null,
      sync_status: 'local',
    };

    const record = dbRowToRecord(row);

    expect(record.fieldUpdatedAt.title).toBeGreaterThanOrEqual(before);
    expect(record.fieldUpdatedAt.status).toBeGreaterThanOrEqual(before);
  });

  it('full PGLite round-trip preserves fieldUpdatedAt across write+read', () => {
    const original: TrackerRecord = {
      id: 'lww-4',
      primaryType: 'task',
      typeTags: ['task'],
      source: 'native',
      archived: false,
      syncStatus: 'local',
      system: { workspace: '/ws', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
      fields: { title: 'Round trip', priority: 'high' },
      fieldUpdatedAt: { title: 1700000000000, priority: 1700000000500 },
    };

    const params = recordToDbParams(original);
    const persistedRow = {
      id: params.id,
      type: params.type,
      type_tags: params.typeTags,
      data: params.data, // string -- exercise the stringified branch too
      workspace: params.workspace,
      document_path: params.documentPath,
      line_number: params.lineNumber,
      created: new Date('2026-01-01'),
      updated: new Date('2026-01-02'),
      last_indexed: new Date('2026-01-02'),
      issue_number: null,
      issue_key: null,
      content: params.content,
      archived: params.archived,
      source: params.source,
      source_ref: params.sourceRef,
      sync_status: params.syncStatus,
    };

    const restored = dbRowToRecord(persistedRow);

    expect(restored.fieldUpdatedAt.title).toBe(1700000000000);
    expect(restored.fieldUpdatedAt.priority).toBe(1700000000500);
    expect(restored.fields.title).toBe('Round trip');
    expect(restored.fields.priority).toBe('high');
  });

  it('trackerItemToRecord honors persisted item.fieldUpdatedAt instead of stamping "now"', () => {
    const item: TrackerItem = {
      id: 'lww-5',
      type: 'bug',
      title: 'A',
      status: 'to-do',
      priority: 'high',
      module: '',
      workspace: '/ws',
      lastIndexed: new Date(),
      fieldUpdatedAt: { title: 1700000000000, status: 1700000000500 },
    };

    const record = trackerItemToRecord(item);

    expect(record.fieldUpdatedAt.title).toBe(1700000000000);
    expect(record.fieldUpdatedAt.status).toBe(1700000000500);
    // Fields not in fieldUpdatedAt fall back to "now" -- just verify they exist
    expect(record.fieldUpdatedAt.priority).toBeTypeOf('number');
  });
});
