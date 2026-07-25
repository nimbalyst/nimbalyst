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
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSyncTrackerItem: vi.fn(),
  mockUnsyncTrackerItem: vi.fn(),
  mockIsTrackerSyncActive: vi.fn(),
  mockGetWorkspaceState: vi.fn((..._args: any[]) => ({})),
  mockGlobalRegistryGet: vi.fn((..._args: any[]) => undefined as any),
}));

// Mock the database before importing ElectronDocumentService
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: mockQuery,
  },
}));

// Mock TrackerSyncManager
vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: mockSyncTrackerItem,
  unsyncTrackerItem: mockUnsyncTrackerItem,
  isTrackerSyncActive: mockIsTrackerSyncActive,
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: mockGetWorkspaceState,
  isAnalyticsEnabled: () => true,
}));

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({
  globalRegistry: {
    get: mockGlobalRegistryGet,
  },
}));

import { ElectronDocumentService } from '../ElectronDocumentService';

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

// ============================================================================
// Setup / Teardown
// ============================================================================

let tempDir: string;
let service: ElectronDocumentService;

beforeEach(async () => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  mockGetWorkspaceState.mockReturnValue({});
  mockGlobalRegistryGet.mockReturnValue(undefined);
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

  it('should NOT call unsyncTrackerItem when sync is not active', async () => {
    mockIsTrackerSyncActive.mockReturnValue(false);

    mockQuery.mockResolvedValueOnce({ rows: [{ source: 'tracked', document_path: '' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await service.deleteTrackerItem('bug-001');

    expect(mockUnsyncTrackerItem).not.toHaveBeenCalled();
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

// ============================================================================
// archiveTrackerItem sync integration
// ============================================================================

describe('archiveTrackerItem sync integration', () => {
  // Archive now pushes to the room only for share-eligible items (NIM-880):
  // syncTrackerItem itself does no policy check, so the call site gates on the
  // per-item policy. Use a shared-mode type here -- the realistic "archive
  // propagates to teammates" scenario. (An unflagged hybrid/local item correctly
  // does NOT push; covered in ElectronDocumentService.planTransition.test.ts.)
  beforeEach(() => {
    mockGlobalRegistryGet.mockReturnValue({ sync: { mode: 'shared', scope: 'project' } });
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

  it('should NOT call syncTrackerItem when sync is not active', async () => {
    mockIsTrackerSyncActive.mockReturnValue(false);

    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ source: 'tracked' })] });
    mockQuery.mockResolvedValueOnce({ rows: [makeTrackerRow({ archived: true })] });

    await service.archiveTrackerItem('bug-001', true);

    expect(mockSyncTrackerItem).not.toHaveBeenCalled();
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
  it('stores local sync_status for local policy items', async () => {
    mockGetWorkspaceState.mockReturnValue({
      trackerSyncPolicies: { bug: 'local' },
    });
    mockGlobalRegistryGet.mockReturnValue({
      sync: { mode: 'shared', scope: 'project' },
    });

    mockQuery.mockResolvedValueOnce({ rows: [{ min_key: null }] }); // kanbanSortOrder MIN query
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT
    mockQuery.mockResolvedValueOnce({ rows: [{ max_num: null }] }); // issue-key MAX query
    mockQuery.mockResolvedValueOnce({ rows: [] }); // issue-key UPDATE
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

  it('stores pending sync_status for shared policy items', async () => {
    mockGetWorkspaceState.mockReturnValue({
      trackerSyncPolicies: { bug: 'shared' },
    });
    mockGlobalRegistryGet.mockReturnValue({
      sync: { mode: 'local', scope: 'project' },
    });

    mockQuery.mockResolvedValueOnce({ rows: [{ min_key: null }] }); // kanbanSortOrder MIN query
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT
    mockQuery.mockResolvedValueOnce({ rows: [{ max_num: null }] }); // issue-key MAX query
    mockQuery.mockResolvedValueOnce({ rows: [] }); // issue-key UPDATE
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
