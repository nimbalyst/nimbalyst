// @vitest-environment node

/**
 * Tests for tracker sync integration in ElectronDocumentService.
 *
 * Verifies that all tracker mutation methods (create, update, archive, delete)
 * correctly call the TrackerSyncManager functions when sync is active.
 *
 * These tests caught the bug where deleteTrackerItem did NOT call unsyncTrackerItem,
 * meaning deletions were never propagated to other users.
 *
 * Mocks: database, TrackerSyncManager, fs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const {
  mockQuery,
  mockSyncTrackerItem,
  mockUnsyncTrackerItem,
  mockIsTrackerSyncActive,
  mockGetWorkspaceState,
  mockGlobalRegistryGet,
  mockIpcHandlers,
  mockSafeHandle,
  mockAssignLocalKeysToRows,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSyncTrackerItem: vi.fn(),
  mockUnsyncTrackerItem: vi.fn(),
  mockIsTrackerSyncActive: vi.fn(),
  mockGetWorkspaceState: vi.fn((..._args: any[]) => ({})),
  mockGlobalRegistryGet: vi.fn((..._args: any[]) => undefined as any),
  mockIpcHandlers: new Map<string, (...args: any[]) => any>(),
  mockSafeHandle: vi.fn(),
  mockAssignLocalKeysToRows: vi.fn(async (..._args: any[]) => new Map<string, string>()),
}));

mockSafeHandle.mockImplementation((channel: string, handler: (...args: any[]) => any) => {
  mockIpcHandlers.set(channel, handler);
});

// Mock the database before importing ElectronDocumentService
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: mockQuery,
    runTransaction: async (statements: Array<{ sql: string; params: unknown[] }>) => {
      for (const statement of statements) await mockQuery(statement.sql, statement.params);
    },
  },
}));

// Mock TrackerSyncManager
vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: mockSyncTrackerItem,
  unsyncTrackerItem: mockUnsyncTrackerItem,
  isTrackerSyncActive: mockIsTrackerSyncActive,
  onTrackerItemApplied: () => () => {},
  onTrackerSyncWorkspaceConnected: () => () => {},
  getTrackerItemForSync: async () => null,
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: mockGetWorkspaceState,
  isAnalyticsEnabled: () => true,
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: mockSafeHandle,
  safeOn: vi.fn(),
}));

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({
  globalRegistry: {
    get: mockGlobalRegistryGet,
    // The policy resolver reads by explicit workspace (NIM-3702). These tests
    // are single-workspace, so both spellings answer from the same stub.
    getForWorkspace: (_workspacePath: string, type: string) => mockGlobalRegistryGet(type),
    hasWorkspaceLayer: () => true,
  },
}));

// Counter behaviour is covered in tracker/__tests__/localKeyAllocator.test.ts.
// Here we only care that the create paths sweep themselves.
vi.mock('../tracker/localKeyAllocator', () => ({
  assignLocalKeysToRows: mockAssignLocalKeysToRows,
}));

import { trackerItemToRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { buildFullDocumentTrackerId } from '@nimbalyst/runtime/plugins/TrackerPlugin/documentHeader/frontmatterUtils';
import { ElectronDocumentService, setupDocumentServiceHandlers } from '../ElectronDocumentService';

const WORKSPACE = '/Users/test/my-project';

// ============================================================================
// Test helpers
// ============================================================================

function makeTrackerRow(overrides: Record<string, any> = {}) {
  return {
    id: 'bug-001',
    type: 'bug',
    data: JSON.stringify({
      title: 'Test bug',
      description: 'A test bug',
      status: 'to-do',
      priority: 'high',
      labels: [],
      linkedSessions: [],
      ...overrides.data,
    }),
    workspace: WORKSPACE,
    document_path: '',
    line_number: null,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    last_indexed: new Date().toISOString(),
    sync_status: 'synced',
    archived: false,
    archived_at: null,
    source: 'tracked',
    source_ref: null,
    ...overrides,
  };
}

function makeTrackerItem(id: string, source: 'native' | 'frontmatter' = 'native') {
  return {
    id,
    type: 'bug' as const,
    title: `Item ${id}`,
    status: 'to-do' as const,
    module: source === 'frontmatter' ? `plans/${id}.md` : '',
    workspace: tempDir,
    lastIndexed: new Date('2026-08-11T00:00:00.000Z'),
    source,
    syncStatus: 'local' as const,
  };
}

// ============================================================================
// Setup / Teardown
// ============================================================================

let tempDir: string;
let service: ElectronDocumentService;

setupDocumentServiceHandlers(() => service);

beforeEach(async () => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  mockGetWorkspaceState.mockReturnValue({});
  mockGlobalRegistryGet.mockReturnValue(undefined);
  mockAssignLocalKeysToRows.mockImplementation(async (..._args: any[]) => new Map<string, string>());
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-sync-test-'));
  service = new ElectronDocumentService(tempDir);
});

afterEach(async () => {
  service?.destroy();
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ============================================================================
// deleteTrackerItem sync integration
// ============================================================================

describe('deleteTrackerItem sync integration', () => {
  it('should call unsyncTrackerItem when sync is active', async () => {
    mockIsTrackerSyncActive.mockReturnValue(true);
    mockUnsyncTrackerItem.mockResolvedValue(undefined);

    // First query: lookup source/document_path for inline removal
    mockQuery.mockResolvedValueOnce({ rows: [{ source: 'tracked', document_path: '' }] });
    // Second query: DELETE
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await service.deleteTrackerItem('bug-001');

    expect(mockUnsyncTrackerItem).toHaveBeenCalledWith('bug-001', tempDir);
  });

  it('queues the room tombstone while disconnected instead of dropping the delete', async () => {
    // NIM-3658: the local row is hard-deleted, so an offline delete that skips
    // the engine leaves nothing behind to carry the intent -- not even for the
    // next launch's drain, which selects surviving rows. Worse, deleting the
    // newest item lowers `MAX(sync_id)`, so the next bootstrap re-delivers the
    // item and re-inserts it. Handing it to the engine regardless of status
    // puts it in `tracker_transactions`, which replays on every reconnect and
    // survives a restart.
    mockIsTrackerSyncActive.mockReturnValue(false);
    mockUnsyncTrackerItem.mockResolvedValue(undefined);

    mockQuery.mockResolvedValueOnce({ rows: [{ source: 'tracked', document_path: '' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await service.deleteTrackerItem('bug-001');

    expect(mockUnsyncTrackerItem).toHaveBeenCalledWith('bug-001', tempDir);
  });

  it('should still delete locally even if sync fails', async () => {
    mockIsTrackerSyncActive.mockReturnValue(true);
    mockUnsyncTrackerItem.mockRejectedValue(new Error('Network error'));

    mockQuery.mockResolvedValueOnce({ rows: [{ source: 'tracked', document_path: '' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // Should not throw
    await service.deleteTrackerItem('bug-001');

    // DB delete was called
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM tracker_items'),
      ['bug-001']
    );
  });

  it('should emit change event with removed ID', async () => {
    mockIsTrackerSyncActive.mockReturnValue(false);

    mockQuery.mockResolvedValueOnce({ rows: [{ source: 'tracked', document_path: '' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const changeEvents: any[] = [];
    service.watchTrackerItems((event) => changeEvents.push(event));

    await service.deleteTrackerItem('bug-002');

    expect(changeEvents).toHaveLength(1);
    expect(changeEvents[0].removed).toEqual(['bug-002']);
  });
});

describe('tracker batch IPC handlers', () => {
  it('rejects every malformed or oversized batch before the first write', async () => {
    const updateInFile = vi.spyOn(service, 'updateTrackerItemInFile');
    const updateStore = vi.spyOn(service, 'updateTrackerItem');
    const handler = mockIpcHandlers.get('document-service:update-tracker-items');
    expect(handler).toBeDefined();

    const invalidPayloads = [
      undefined,
      { entries: [null] },
      { entries: [{ itemId: ' ', fileUpdates: { status: 'done' } }] },
      { entries: [{ itemId: 'bug-1', fileUpdates: [] }] },
      { entries: [{ itemId: 'bug-1', fileUpdates: {}, storeUpdates: {} }] },
      { entries: [{ itemId: 'bug-1', storeUpdates: { status: 'done' }, sharing: 'org' }] },
      { entries: Array.from({ length: 101 }, (_, index) => ({
        itemId: `bug-${index}`,
        storeUpdates: { status: 'done' },
      })) },
    ];

    for (const payload of invalidPayloads) {
      const result = await handler!({}, payload);
      expect(result.success).toBe(false);
    }
    expect(updateInFile).not.toHaveBeenCalled();
    expect(updateStore).not.toHaveBeenCalled();
  });

  it('routes file and store entries through the exact single-item write functions', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    mockIsTrackerSyncActive.mockReturnValue(false);
    const updateInFile = vi.spyOn(service, 'updateTrackerItemInFile')
      .mockResolvedValue(makeTrackerItem('plan-file', 'frontmatter'));
    const updateStore = vi.spyOn(service, 'updateTrackerItem')
      .mockResolvedValue(makeTrackerItem('bug-store'));
    vi.spyOn(service, 'propagateInverseForUpdate').mockResolvedValue(undefined);

    const handler = mockIpcHandlers.get('document-service:update-tracker-items');
    const result = await handler!({}, {
      entries: [
        { itemId: 'plan-file', fileUpdates: { collection: [{ itemId: 'milestone-1' }] } },
        { itemId: 'bug-store', storeUpdates: { priority: 'high' }, sharing: 'personal' },
      ],
    });

    expect(result.success).toBe(true);
    expect(updateInFile).toHaveBeenCalledWith('plan-file', {
      collection: [{ itemId: 'milestone-1' }],
    });
    expect(updateStore).toHaveBeenCalledWith('bug-store', { priority: 'high' });
  });

  it('keeps a batched file relationship update canonical in nested customFields', async () => {
    const relativePath = 'plans/batch-plan.md';
    const itemId = buildFullDocumentTrackerId('plan', relativePath);
    await fs.mkdir(path.join(tempDir, 'plans'), { recursive: true });
    await fs.writeFile(path.join(tempDir, relativePath), `---
planStatus:
  title: Batch plan
  status: draft
  collection:
    - itemId: milestone-a
---

# Body
`, 'utf-8');

    let row = makeTrackerRow({
      id: itemId,
      type: 'plan',
      workspace: tempDir,
      source: 'frontmatter',
      source_ref: relativePath,
      document_path: relativePath,
      data: JSON.stringify({
        title: 'Batch plan',
        status: 'draft',
        customFields: { collection: [{ itemId: 'milestone-a' }] },
      }),
    });
    mockGlobalRegistryGet.mockReturnValue({
      sharing: 'personal',
      modes: { inline: false, fullDocument: true },
      fields: [{
        name: 'collection',
        type: 'relationship',
        relationshipTypeKey: 'in-collection',
        multiValue: true,
      }],
    });
    mockIsTrackerSyncActive.mockReturnValue(false);
    vi.spyOn(service, 'propagateInverseForUpdate').mockResolvedValue(undefined);
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT data FROM tracker_items WHERE id = $1')) {
        return { rows: [{ data: row.data }] };
      }
      if (normalized.startsWith('SELECT * FROM tracker_items WHERE id = $1')) {
        return { rows: [row] };
      }
      if (normalized.startsWith('UPDATE tracker_items SET data = $1, updated = NOW() WHERE id = $2')) {
        row = { ...row, data: params?.[0] as string };
        return { rows: [] };
      }
      throw new Error(`Unexpected query in test: ${normalized}`);
    });

    const handler = mockIpcHandlers.get('document-service:update-tracker-items');
    const result = await handler!({}, {
      entries: [{
        itemId,
        fileUpdates: { collection: [{ itemId: 'milestone-b' }] },
      }],
    });

    expect(result.success).toBe(true);
    const stored = JSON.parse(row.data);
    expect(stored.customFields.collection).toEqual([{ itemId: 'milestone-b' }]);
    expect(stored).not.toHaveProperty('collection');
    expect(await fs.readFile(path.join(tempDir, relativePath), 'utf-8')).toContain('itemId: milestone-b');
  });

  it('reports an entry failure and continues with the rest of the batch', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    mockIsTrackerSyncActive.mockReturnValue(false);
    const updateInFile = vi.spyOn(service, 'updateTrackerItemInFile')
      .mockRejectedValueOnce(new Error('source file is read-only'))
      .mockResolvedValueOnce(makeTrackerItem('plan-ok', 'frontmatter'));
    vi.spyOn(service, 'propagateInverseForUpdate').mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const handler = mockIpcHandlers.get('document-service:update-tracker-items');
    const result = await handler!({}, {
      entries: [
        { itemId: 'plan-failed', fileUpdates: { status: 'in-development' } },
        { itemId: 'plan-ok', fileUpdates: { status: 'in-review' } },
      ],
    });

    expect(result).toEqual({
      success: false,
      results: [
        { itemId: 'plan-failed', success: false, error: 'source file is read-only' },
        { itemId: 'plan-ok', success: true },
      ],
    });
    expect(updateInFile).toHaveBeenCalledTimes(2);
  });

  it('caps and validates relationship reindex ids, then loads a valid batch in one SELECT', async () => {
    const handler = mockIpcHandlers.get('document-service:tracker-item-reindex-relationships');
    expect(handler).toBeDefined();

    expect((await handler!({}, { itemIds: [null] })).success).toBe(false);
    expect((await handler!({}, {
      itemIds: Array.from({ length: 101 }, (_, index) => `bug-${index}`),
    })).success).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tracker_items WHERE id IN')) {
        return {
          rows: [
            makeTrackerRow({ id: 'bug-1', workspace: tempDir }),
            makeTrackerRow({ id: 'bug-2', workspace: tempDir }),
          ],
        };
      }
      return { rows: [] };
    });

    const result = await handler!({}, { itemIds: ['bug-1', 'bug-1', 'bug-2'] });
    expect(result.success).toBe(true);
    const selects = mockQuery.mock.calls.filter(([sql]) => String(sql).includes('FROM tracker_items WHERE id IN'));
    const relationshipDeletes = mockQuery.mock.calls.filter(([sql]) => (
      String(sql).includes('DELETE FROM tracker_relationship_index')
      && String(sql).includes('source_item_id IN')
    ));
    expect(selects).toHaveLength(1);
    expect(selects[0][1]).toEqual(['bug-1', 'bug-2']);
    expect(relationshipDeletes).toHaveLength(1);
    expect(relationshipDeletes[0][1]).toEqual([tempDir, 'bug-1', 'bug-2']);
  });
});

// ============================================================================
// archiveTrackerItem sync integration
// ============================================================================

describe('archiveTrackerItem sync integration', () => {
  // Archive now pushes to the room only for share-eligible items (NIM-880):
  // syncTrackerItem itself does no policy check, so the call site gates on the
  // per-item policy. Use a published-by-default team tracker here -- the realistic "archive
  // propagates to teammates" scenario. (A draft/personal item correctly
  // does NOT push; covered in ElectronDocumentService.planTransition.test.ts.)
  beforeEach(() => {
    mockGlobalRegistryGet.mockReturnValue({ sharing: 'team', draftByDefault: false });
  });

  it('should call syncTrackerItem when archiving with sync active', async () => {
    mockIsTrackerSyncActive.mockReturnValue(true);
    mockSyncTrackerItem.mockResolvedValue(undefined);

    // Lookup row
    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ source: 'tracked' })] });
    // UPDATE archived RETURNING the exact mutation snapshot
    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ archived: true })] });

    await service.archiveTrackerItem('bug-001', true);

    expect(mockSyncTrackerItem).toHaveBeenCalled();
    const syncedItem = mockSyncTrackerItem.mock.calls[0][0];
    expect(syncedItem.id).toBe('bug-001');
  });

  it('should call syncTrackerItem when un-archiving with sync active', async () => {
    mockIsTrackerSyncActive.mockReturnValue(true);
    mockSyncTrackerItem.mockResolvedValue(undefined);

    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ archived: true, source: 'tracked' })] });
    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ archived: false })] });

    await service.archiveTrackerItem('bug-001', false);

    expect(mockSyncTrackerItem).toHaveBeenCalled();
  });

  it('marks the row pending when sync is not active so the reconnect drain pushes it', async () => {
    // NIM-3657: the `if (connected)` here had no `else`, so an offline archive
    // of an already-synced item (sync_status='synced', sync_id set) never
    // entered the drain's candidate set and never reached the room at all.
    mockIsTrackerSyncActive.mockReturnValue(false);

    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ source: 'tracked' })] });
    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ archived: true })] });
    // `updateTrackerItemSyncStatus` re-resolves the row and re-reads it for the
    // watcher broadcast, so every later lookup must find the item.
    mockQuery.mockResolvedValue({ rows: [makeTrackerRow({ archived: true })] });

    await service.archiveTrackerItem('bug-001', true);

    expect(mockSyncTrackerItem).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET sync_status = $1'),
      ['pending', 'bug-001'],
    );
  });

  it('should still archive locally if sync fails', async () => {
    mockIsTrackerSyncActive.mockReturnValue(true);
    mockSyncTrackerItem.mockRejectedValue(new Error('Sync failed'));

    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ source: 'tracked' })] });
    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ archived: true })] });

    // Should not throw
    const item = await service.archiveTrackerItem('bug-001', true);
    expect(item).toBeDefined();
  });
});

describe('createTrackerItem sync status policy', () => {
  it('stores local sync_status for personal tracker items', async () => {
    mockGlobalRegistryGet.mockReturnValue({
      sharing: 'personal',
      draftByDefault: false,
    });

    mockIsTrackerSyncActive.mockReturnValue(false);

    mockQuery.mockResolvedValueOnce({ rows: [{ min_key: null }] }); // kanbanSortOrder MIN query
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT
    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ id: 'bug-local', sync_status: 'local' })] }); // SELECT

    await service.createTrackerItem({
      id: 'bug-local',
      type: 'bug',
      title: 'Local bug',
      status: 'to-do',
      priority: 'high',
      workspace: WORKSPACE,
    });

    // INSERT is the second query (index 1) after kanbanSortOrder; sync_status
    // is the 6th INSERT param ($6) -- after id, type, type_tags, data, workspace.
    expect(mockQuery.mock.calls[1]?.[1]?.[5]).toBe('local');
  });

  it('stores pending sync_status for published team tracker items', async () => {
    mockGlobalRegistryGet.mockReturnValue({
      sharing: 'team',
      draftByDefault: false,
    });

    // The room will assign the key after this published item is synced.
    mockIsTrackerSyncActive.mockReturnValue(true);

    mockQuery.mockResolvedValueOnce({ rows: [{ min_key: null }] }); // kanbanSortOrder MIN query
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT
    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ id: 'bug-shared', sync_status: 'pending' })] }); // SELECT

    await service.createTrackerItem({
      id: 'bug-shared',
      type: 'bug',
      title: 'Shared bug',
      status: 'to-do',
      priority: 'high',
      workspace: WORKSPACE,
    });

    // INSERT is the second query (index 1) after kanbanSortOrder; sync_status
    // is the 6th INSERT param ($6) -- after id, type, type_tags, data, workspace.
    expect(mockQuery.mock.calls[1]?.[1]?.[5]).toBe('pending');
  });

  // The insert leaves `local_key` NULL, and numbers used to be minted only by
  // the list query. The item this returns is what the renderer inserts
  // optimistically, so without a sweep here it renders "No key yet" until the
  // next full re-list (NIM.2842).
  it('numbers a newly created personal item before returning it', async () => {
    mockGlobalRegistryGet.mockReturnValue({ sharing: 'personal', draftByDefault: false });
    mockIsTrackerSyncActive.mockReturnValue(false);
    mockAssignLocalKeysToRows.mockResolvedValue(new Map([['bug-local', 'NIM.42']]));

    mockQuery.mockResolvedValueOnce({ rows: [{ min_key: null }] }); // kanbanSortOrder MIN
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT
    mockQuery.mockResolvedValueOnce({
      rows: [makeTrackerRow({ id: 'bug-local', sync_status: 'local', local_key: null })],
    }); // read-back

    const created = await service.createTrackerItem({
      id: 'bug-local',
      type: 'bug',
      title: 'Local bug',
      status: 'to-do',
      priority: 'high',
      workspace: WORKSPACE,
    });

    expect(mockAssignLocalKeysToRows).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      tempDir,
      ['bug-local'],
    );
    expect(created.localKey).toBe('NIM.42');
  });
});

describe('updateTrackerItem sync payload', () => {
  it('pushes an edited nested field value when the local schema does not recognize it as a relationship', async () => {
    const staleValue = [{ itemId: 'bug-stale', relationshipTypeKey: 'depends-on' }];
    const editedValue = [{ itemId: 'bug-new', relationshipTypeKey: 'depends-on' }];
    let row = makeTrackerRow({
      workspace: tempDir,
      data: {
        title: 'Test bug',
        status: 'to-do',
        activity: [],
        customFields: { dependsOn: staleValue },
      },
    });

    mockGlobalRegistryGet.mockReturnValue({
      sharing: 'team',
      draftByDefault: false,
      fields: [{ name: 'title', type: 'string' }],
    });
    mockIsTrackerSyncActive.mockReturnValue(true);
    mockSyncTrackerItem.mockResolvedValue(undefined);
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.startsWith('SELECT')) return { rows: [row] };
      if (normalized.startsWith('UPDATE tracker_items SET data = $1')) {
        row = { ...row, data: params?.[0] as string };
        return { rows: [row] };
      }
      throw new Error(`Unexpected query in test: ${normalized}`);
    });

    const updateHandler = mockIpcHandlers.get('document-service:update-tracker-item');
    expect(updateHandler).toBeDefined();
    const result = await updateHandler!({}, {
      itemId: 'bug-001',
      updates: { dependsOn: editedValue },
    });

    expect(result.success).toBe(true);
    expect(mockSyncTrackerItem).toHaveBeenCalledTimes(1);
    const pushedPayload = {
      fields: trackerItemToRecord(mockSyncTrackerItem.mock.calls[0][0]).fields,
    };
    expect(pushedPayload.fields.dependsOn).toEqual(editedValue);
  });
});

// ============================================================================
// Inline item deletion (file system interaction)
// ============================================================================

describe('deleteTrackerItem inline items', () => {
  it('should handle ENOENT gracefully when inline source file is missing', async () => {
    mockIsTrackerSyncActive.mockReturnValue(false);

    // Item is inline with a document_path that doesn't exist
    mockQuery.mockResolvedValueOnce({
      rows: [{ source: 'inline', document_path: 'nonexistent.md' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    // Should not throw
    await service.deleteTrackerItem('inline-001');

    // DB delete was still called
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM tracker_items'),
      ['inline-001']
    );
  });
});

// ============================================================================
// Change event watchers
// ============================================================================

describe('tracker change event watchers', () => {
  it('should notify watcher on delete', async () => {
    mockIsTrackerSyncActive.mockReturnValue(false);
    mockQuery.mockResolvedValueOnce({ rows: [{ source: 'tracked', document_path: '' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const events: any[] = [];
    service.watchTrackerItems((e) => events.push(e));

    await service.deleteTrackerItem('bug-003');

    expect(events).toHaveLength(1);
    expect(events[0].removed).toEqual(['bug-003']);
  });

  it('should notify watchers with updated item on archive', async () => {
    mockIsTrackerSyncActive.mockReturnValue(false);

    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ source: 'tracked' })] });
    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ archived: true })] });

    const events: any[] = [];
    service.watchTrackerItems((e) => events.push(e));

    await service.archiveTrackerItem('bug-001', true);

    expect(events).toHaveLength(1);
    expect(events[0].updated).toHaveLength(1);
    expect(events[0].updated[0].id).toBe('bug-001');
  });
});

// ============================================================================
// getTrackerItemContent decoding
// ============================================================================

describe('getTrackerItemContent', () => {
  it('decodes the JSON-encoded content column back into plain markdown', async () => {
    // content is persisted as JSON.stringify(markdown) by updateTrackerItemContent.
    // Reading it back without JSON.parse leaves literal quotes/escaped \n --
    // this is the bug: markdown rendered fine on create, then as a raw string
    // after closing and reopening the item (fresh DB read).
    const markdown = '**Objetivo**: validar\n\n### Links';
    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ id: 'bug-001' })] }); // resolve row
    mockQuery.mockResolvedValueOnce({ rows: [{ content: JSON.stringify(markdown) }] }); // SELECT content

    const content = await service.getTrackerItemContent('bug-001');

    expect(content).toBe(markdown);
  });
});
