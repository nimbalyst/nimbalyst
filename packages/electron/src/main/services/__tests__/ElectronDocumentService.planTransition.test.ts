/**
 * Integration test for full-document tracker status-transition capture.
 *
 * Verifies that ElectronDocumentService.captureFrontmatterTrackerTransition
 * (the path that records plan/decision status history from a DIRECT frontmatter
 * edit) issues the right DB write and emits a change event. The pure diff logic
 * is covered separately in tracker/__tests__/frontmatterTrackerTransition.test.ts;
 * this asserts the service wiring (SQL + watcher notification) without a restart.
 *
 * Mocks: database, TrackerSyncManager, TrackerIdentityService, store, registry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const {
  mockQuery,
  mockGetWorkspaceState,
  mockGlobalRegistryGet,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetWorkspaceState: vi.fn((..._args: any[]) => ({})),
  mockGlobalRegistryGet: vi.fn((..._args: any[]) => undefined as any),
}));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: mockQuery },
}));

vi.mock('../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(),
  unsyncTrackerItem: vi.fn(),
  isTrackerSyncActive: vi.fn(() => false),
}));

vi.mock('../MainBodyDocService', () => ({
  applyHeadlessBodyMarkdown: vi.fn(),
}));

vi.mock('../TrackerIdentityService', () => ({
  getCurrentIdentity: () => ({ email: 'greg@stravu.com', displayName: 'Greg' }),
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: mockGetWorkspaceState,
  isAnalyticsEnabled: () => true,
}));

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({
  globalRegistry: { get: mockGlobalRegistryGet },
}));

import { ElectronDocumentService } from '../ElectronDocumentService';
import { syncTrackerItem, unsyncTrackerItem, isTrackerSyncActive } from '../TrackerSyncManager';
import { applyHeadlessBodyMarkdown } from '../MainBodyDocService';

let tempDir: string;
let service: ElectronDocumentService;

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetWorkspaceState.mockReturnValue({});
  mockGlobalRegistryGet.mockReturnValue(undefined);
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-transition-test-'));
  service = new ElectronDocumentService(tempDir);
});

afterEach(async () => {
  service?.destroy();
  await fs.rm(tempDir, { recursive: true, force: true });
});

const REL = 'plans/example.md';

function capture(frontmatter: Record<string, any>) {
  return (service as any).captureFrontmatterTrackerTransition(REL, frontmatter);
}

describe('captureFrontmatterTrackerTransition', () => {
  it('records a status_changed transition and emits an update event when the plan status changes', async () => {
    // 1) SELECT existing projection row (status in-design)
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: `fm:plan:${REL}`, data: JSON.stringify({ title: 'Example', status: 'in-design', activity: [] }) }],
    });
    // 2) UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 3) SELECT persisted row (re-read for the change event)
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: `fm:plan:${REL}`,
        type: 'plan',
        source: 'frontmatter',
        source_ref: REL,
        workspace: tempDir,
        data: JSON.stringify({ title: 'Example', status: 'in-development', activity: [{ id: 'a', action: 'status_changed' }] }),
        sync_status: 'local',
        last_indexed: new Date().toISOString(),
      }],
    });

    const events: any[] = [];
    service.watchTrackerItems(e => events.push(e));

    await capture({ planStatus: { title: 'Example', status: 'in-development' } });

    // The 2nd query is the UPDATE; assert it carries the appended transition.
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE tracker_items SET data');
    const writtenData = JSON.parse(updateCall[1][0]);
    expect(writtenData.status).toBe('in-development');
    expect(writtenData.activity).toHaveLength(1);
    expect(writtenData.activity[0]).toMatchObject({
      action: 'status_changed',
      field: 'status',
      oldValue: 'in-design',
      newValue: 'in-development',
    });

    // A change event for the updated item was emitted.
    expect(events).toHaveLength(1);
    expect(events[0].updated).toHaveLength(1);
    expect(events[0].added).toHaveLength(0);
  });

  it('does not write or emit when no tracked field changed', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: `fm:plan:${REL}`, data: JSON.stringify({ title: 'Example', status: 'draft', activity: [] }) }],
    });

    const events: any[] = [];
    service.watchTrackerItems(e => events.push(e));

    await capture({ planStatus: { title: 'Example', status: 'draft' } });

    // Only the initial SELECT ran -- no UPDATE, no re-read, no event.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
  });

  it('lazily materializes a row (single insert) the first time an edited plan has no projection', async () => {
    // 1) SELECT existing -> none
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 2) INSERT
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 3) SELECT persisted
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: `fm:plan:${REL}`, type: 'plan', source: 'frontmatter', source_ref: REL,
        workspace: tempDir, data: JSON.stringify({ title: 'Example', status: 'draft', activity: [{ id: 'a', action: 'created' }] }),
        sync_status: 'local', last_indexed: new Date().toISOString(),
      }],
    });

    const events: any[] = [];
    service.watchTrackerItems(e => events.push(e));

    await capture({ planStatus: { title: 'Example', status: 'draft' } });

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO tracker_items');
    const writtenData = JSON.parse(insertCall[1][2]);
    expect(writtenData.activity[0]).toMatchObject({ action: 'created' });
    expect(events[0].added).toHaveLength(1);
  });

  it('ignores documents without tracker frontmatter (no DB hit)', async () => {
    await capture({ title: 'Just a doc', summary: 'no tracker block' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  describe('per-plan share reconciliation (NIM-876)', () => {
    beforeEach(() => {
      // plan is a hybrid type: per-item sharing gated by the share flag.
      mockGlobalRegistryGet.mockReturnValue({ sync: { mode: 'hybrid', scope: 'project' } });
    });

    it('shares a flagged plan: a share-only flip pushes the item to the team room', async () => {
      vi.mocked(isTrackerSyncActive).mockReturnValue(true);
      // 1) SELECT existing (unshared, status unchanged)
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: `fm:plan:${REL}`, data: JSON.stringify({ title: 'Example', status: 'draft', activity: [] }) }],
      });
      // 2) UPDATE (forced by the share flip even though no tracked field changed)
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // 3) SELECT persisted
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: `fm:plan:${REL}`, type: 'plan', source: 'frontmatter', source_ref: REL,
          workspace: tempDir,
          data: JSON.stringify({ title: 'Example', status: 'draft', share: { status: 'team', body: 'team' }, activity: [] }),
          sync_status: 'local', last_indexed: new Date().toISOString(),
        }],
      });

      await capture({ planStatus: { title: 'Example', status: 'draft', share: { status: 'team', body: 'team' } } });

      // The UPDATE persisted the share flag.
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain('UPDATE tracker_items SET data');
      expect(JSON.parse(updateCall[1][0]).share).toEqual({ status: 'team', body: 'team' });

      // The item was pushed to the team room (sync active), not just marked pending.
      expect(syncTrackerItem).toHaveBeenCalledTimes(1);
      expect(unsyncTrackerItem).not.toHaveBeenCalled();
    });

    it('marks a flagged plan pending when sync is not yet active', async () => {
      vi.mocked(isTrackerSyncActive).mockReturnValue(false);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: `fm:plan:${REL}`, data: JSON.stringify({ title: 'Example', status: 'draft', activity: [] }) }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE data
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: `fm:plan:${REL}`, type: 'plan', source: 'frontmatter', source_ref: REL,
          workspace: tempDir,
          data: JSON.stringify({ title: 'Example', status: 'draft', share: { status: 'team' }, activity: [] }),
          sync_status: 'local', last_indexed: new Date().toISOString(),
        }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE sync_status pending

      await capture({ planStatus: { title: 'Example', status: 'draft', share: { status: 'team' } } });

      expect(syncTrackerItem).not.toHaveBeenCalled();
      const lastCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
      expect(lastCall[0]).toContain("sync_status = 'pending'");
    });

    it('unshares a plan: removing the share flag deletes it from the room and resets to local', async () => {
      vi.mocked(isTrackerSyncActive).mockReturnValue(true);
      // 1) SELECT existing (already shared)
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: `fm:plan:${REL}`, data: JSON.stringify({ title: 'Example', status: 'draft', share: { status: 'team' }, activity: [] }) }],
      });
      // 2) UPDATE data (share removed)
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // 3) SELECT persisted
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: `fm:plan:${REL}`, type: 'plan', source: 'frontmatter', source_ref: REL,
          workspace: tempDir,
          data: JSON.stringify({ title: 'Example', status: 'draft', activity: [] }),
          sync_status: 'synced', last_indexed: new Date().toISOString(),
        }],
      });
      // 4) UPDATE sync_status local
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // Frontmatter no longer carries the share block -> flag cleared.
      await capture({ planStatus: { title: 'Example', status: 'draft' } });

      // The persisted data dropped the share flag.
      const updateCall = mockQuery.mock.calls[1];
      expect(JSON.parse(updateCall[1][0]).share).toBeUndefined();

      // Removed from the team room and reset to local.
      expect(unsyncTrackerItem).toHaveBeenCalledTimes(1);
      expect(unsyncTrackerItem).toHaveBeenCalledWith(`fm:plan:${REL}`, tempDir);
      expect(syncTrackerItem).not.toHaveBeenCalled();
      const lastCall = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
      expect(lastCall[0]).toContain("sync_status = 'local'");
    });

    it('seeds the plan body into the tracker-content room when sharing (body rides the item)', async () => {
      vi.mocked(isTrackerSyncActive).mockReturnValue(true);

      // A real file with frontmatter + body must exist so shareFrontmatterBody
      // can read the markdown to seed the tracker-content room.
      await fs.mkdir(path.join(tempDir, 'plans'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, REL),
        '---\nplanStatus:\n  title: Example\n  status: draft\n  share:\n    status: team\n---\n## Plan body\n\nDetails here.\n',
        'utf8',
      );

      const sharedRow = {
        id: `fm:plan:${REL}`, type: 'plan', source: 'frontmatter', source_ref: REL,
        workspace: tempDir,
        data: JSON.stringify({ title: 'Example', status: 'draft', share: { status: 'team' }, activity: [] }),
        sync_status: 'local', body_version: 1, last_indexed: new Date().toISOString(),
      };
      // 1) initial SELECT: UNSHARED so the share flip is detected.
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: `fm:plan:${REL}`, data: JSON.stringify({ title: 'Example', status: 'draft', activity: [] }) }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // 2) UPDATE data
      mockQuery.mockResolvedValueOnce({ rows: [sharedRow] }); // 3) SELECT persisted (now shared)
      // Catch-all for reconcile -> updateTrackerItemContent queries.
      mockQuery.mockResolvedValue({ rows: [sharedRow] });

      await capture({ planStatus: { title: 'Example', status: 'draft', share: { status: 'team' } } });

      expect(applyHeadlessBodyMarkdown).toHaveBeenCalledTimes(1);
      const [ws, itemId, body] = vi.mocked(applyHeadlessBodyMarkdown).mock.calls[0];
      expect(ws).toBe(tempDir);
      expect(itemId).toBe(`fm:plan:${REL}`);
      expect(body).toContain('Plan body');
    });

    it('does not share an unflagged plan on an ordinary status change (no leak)', async () => {
      vi.mocked(isTrackerSyncActive).mockReturnValue(true);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: `fm:plan:${REL}`, data: JSON.stringify({ title: 'Example', status: 'draft', activity: [] }) }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE data
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: `fm:plan:${REL}`, type: 'plan', source: 'frontmatter', source_ref: REL,
          workspace: tempDir,
          data: JSON.stringify({ title: 'Example', status: 'in-development', activity: [{ id: 'a', action: 'status_changed' }] }),
          sync_status: 'local', last_indexed: new Date().toISOString(),
        }],
      });

      await capture({ planStatus: { title: 'Example', status: 'in-development' } });

      // Status transition recorded, but no team sync for an unflagged hybrid plan.
      expect(syncTrackerItem).not.toHaveBeenCalled();
      expect(unsyncTrackerItem).not.toHaveBeenCalled();
    });

    // NIM-880 (a): an already-shared plan whose lifecycle field changes must
    // push the updated metadata to the room -- there is no share flip, so the
    // earlier gate skipped it and the change was stranded locally.
    it('syncs an already-shared plan when a lifecycle field changes (no share flip)', async () => {
      vi.mocked(isTrackerSyncActive).mockReturnValue(true);
      // 1) SELECT existing -- ALREADY shared, status in-design.
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: `fm:plan:${REL}`, data: JSON.stringify({ title: 'Example', status: 'in-design', share: { status: 'team' }, activity: [] }) }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // 2) UPDATE data
      // 3) SELECT persisted -- still shared, status advanced.
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: `fm:plan:${REL}`, type: 'plan', source: 'frontmatter', source_ref: REL,
          workspace: tempDir,
          data: JSON.stringify({ title: 'Example', status: 'in-development', share: { status: 'team' }, activity: [{ id: 'a', action: 'status_changed' }] }),
          sync_status: 'synced', last_indexed: new Date().toISOString(),
        }],
      });
      mockQuery.mockResolvedValue({ rows: [] }); // catch-all

      await capture({ planStatus: { title: 'Example', status: 'in-development', share: { status: 'team' } } });

      // Metadata pushed (no body re-seed needed for a pure field change).
      expect(syncTrackerItem).toHaveBeenCalledTimes(1);
      expect(unsyncTrackerItem).not.toHaveBeenCalled();
    });

    // NIM-880 (a), offline variant: an already-shared field change while
    // disconnected must mark the row pending so the reconnect backfill re-pushes
    // the new metadata.
    it('marks an already-shared plan pending when offline and a lifecycle field changes', async () => {
      vi.mocked(isTrackerSyncActive).mockReturnValue(false);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: `fm:plan:${REL}`, data: JSON.stringify({ title: 'Example', status: 'in-design', share: { status: 'team' }, activity: [] }) }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE data
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: `fm:plan:${REL}`, type: 'plan', source: 'frontmatter', source_ref: REL,
          workspace: tempDir,
          data: JSON.stringify({ title: 'Example', status: 'in-development', share: { status: 'team' }, activity: [{ id: 'a', action: 'status_changed' }] }),
          sync_status: 'synced', last_indexed: new Date().toISOString(),
        }],
      });
      mockQuery.mockResolvedValue({ rows: [] }); // catch-all (pending UPDATE)

      await capture({ planStatus: { title: 'Example', status: 'in-development', share: { status: 'team' } } });

      expect(syncTrackerItem).not.toHaveBeenCalled();
      const pendingCall = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("sync_status = 'pending'"));
      expect(pendingCall).toBeDefined();
    });

    // NIM-880 (d): sharing a plan while sync is inactive must still seed the
    // body locally (bump body_version + cache + headless doc) so the reconnect
    // backfill ships a real bodyVersion and the body is present for teammates.
    it('seeds the plan body when sharing offline (sync inactive)', async () => {
      vi.mocked(isTrackerSyncActive).mockReturnValue(false);

      await fs.mkdir(path.join(tempDir, 'plans'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, REL),
        '---\nplanStatus:\n  title: Example\n  status: draft\n  share:\n    status: team\n---\n## Plan body\n\nDetails here.\n',
        'utf8',
      );

      const sharedRow = {
        id: `fm:plan:${REL}`, type: 'plan', source: 'frontmatter', source_ref: REL,
        workspace: tempDir,
        data: JSON.stringify({ title: 'Example', status: 'draft', share: { status: 'team' }, activity: [] }),
        sync_status: 'local', body_version: 1, last_indexed: new Date().toISOString(),
      };
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: `fm:plan:${REL}`, data: JSON.stringify({ title: 'Example', status: 'draft', activity: [] }) }],
      }); // 1) SELECT existing (unshared)
      mockQuery.mockResolvedValueOnce({ rows: [] }); // 2) UPDATE data
      mockQuery.mockResolvedValueOnce({ rows: [sharedRow] }); // 3) SELECT persisted (now shared)
      mockQuery.mockResolvedValue({ rows: [sharedRow] }); // catch-all for body persist + pending

      await capture({ planStatus: { title: 'Example', status: 'draft', share: { status: 'team' } } });

      // Body seeded into the tracker-content room even though sync is offline...
      expect(applyHeadlessBodyMarkdown).toHaveBeenCalledTimes(1);
      // ...and the row is marked pending for the reconnect backfill.
      const pendingCall = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("sync_status = 'pending'"));
      expect(pendingCall).toBeDefined();
      // No live push while offline.
      expect(syncTrackerItem).not.toHaveBeenCalled();
    });

    // NIM-880 (c): unsharing while offline must mark the row pending (not
    // 'local') so the reconnect backfill can issue the room tombstone. Resetting
    // straight to 'local' with sync_id intact stranded the deletion.
    it('marks an unshared plan pending when offline so reconnect backfill removes it', async () => {
      vi.mocked(isTrackerSyncActive).mockReturnValue(false);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: `fm:plan:${REL}`, data: JSON.stringify({ title: 'Example', status: 'draft', share: { status: 'team' }, activity: [] }) }],
      }); // 1) SELECT existing (shared)
      mockQuery.mockResolvedValueOnce({ rows: [] }); // 2) UPDATE data (share removed)
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: `fm:plan:${REL}`, type: 'plan', source: 'frontmatter', source_ref: REL,
          workspace: tempDir,
          data: JSON.stringify({ title: 'Example', status: 'draft', activity: [] }),
          sync_status: 'synced', last_indexed: new Date().toISOString(),
        }],
      }); // 3) SELECT persisted (unshared)
      mockQuery.mockResolvedValue({ rows: [] }); // catch-all

      await capture({ planStatus: { title: 'Example', status: 'draft' } });

      // Offline: no live delete (it would no-op), but the row is queued pending.
      expect(unsyncTrackerItem).not.toHaveBeenCalled();
      const pendingCall = mockQuery.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes("sync_status = 'pending'"));
      expect(pendingCall).toBeDefined();
    });
  });
});

/**
 * NIM-880 (b): updateTrackerItemContent / archiveTrackerItem must gate the
 * team push by the PER-ITEM policy (shouldSyncTrackerItem), not merely by
 * "is sync active". syncTrackerItem itself does no policy gating, so an
 * unflagged hybrid item would otherwise leak to the room on a body save or
 * an archive toggle.
 */
describe('per-item sync gating for body-save and archive', () => {
  beforeEach(() => {
    vi.mocked(isTrackerSyncActive).mockReturnValue(true);
    // hybrid type: per-item sharing gated by the share flag.
    mockGlobalRegistryGet.mockReturnValue({ sync: { mode: 'hybrid', scope: 'project' } });
  });

  function nativeRow(data: Record<string, any>, extra: Record<string, any> = {}) {
    return {
      id: 'bug-1', type: 'bug', source: 'native', source_ref: null,
      document_path: null, workspace: tempDir,
      data: JSON.stringify(data),
      sync_status: 'local', last_indexed: new Date().toISOString(),
      ...extra,
    };
  }

  it('does not push the body of an unflagged hybrid item (no leak)', async () => {
    const row = nativeRow({ title: 'Local bug', status: 'open' }, { body_version: 0 });
    mockQuery.mockResolvedValueOnce({ rows: [row] }); // resolve (direct SELECT)
    mockQuery.mockResolvedValueOnce({ rows: [{ body_version: 1 }] }); // UPDATE RETURNING
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT body_cache
    mockQuery.mockResolvedValueOnce({ rows: [row] }); // SELECT for change event

    await service.updateTrackerItemContent('bug-1', { some: 'content' });

    expect(syncTrackerItem).not.toHaveBeenCalled();
  });

  it('pushes the body of a flagged hybrid item', async () => {
    const sharedData = { title: 'Shared bug', status: 'open', share: { status: 'team' } };
    const row = nativeRow(sharedData, { body_version: 0 });
    const persisted = nativeRow(sharedData, { body_version: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [row] }); // resolve
    mockQuery.mockResolvedValueOnce({ rows: [{ body_version: 1 }] }); // UPDATE RETURNING
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT body_cache
    mockQuery.mockResolvedValueOnce({ rows: [persisted] }); // SELECT for change event

    await service.updateTrackerItemContent('bug-1', { some: 'content' });

    expect(syncTrackerItem).toHaveBeenCalledTimes(1);
  });

  it('does not push the archive toggle of an unflagged hybrid item (no leak)', async () => {
    const row = nativeRow({ title: 'Local bug', status: 'open' });
    mockQuery.mockResolvedValueOnce({ rows: [row] }); // resolve
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE archived
    mockQuery.mockResolvedValueOnce({ rows: [row] }); // SELECT for change event

    await service.archiveTrackerItem('bug-1', true);

    expect(syncTrackerItem).not.toHaveBeenCalled();
  });

  it('pushes the archive toggle of a flagged hybrid item', async () => {
    const sharedData = { title: 'Shared bug', status: 'open', shared: true };
    const row = nativeRow(sharedData);
    mockQuery.mockResolvedValueOnce({ rows: [row] }); // resolve
    mockQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE archived
    mockQuery.mockResolvedValueOnce({ rows: [row] }); // SELECT for change event

    await service.archiveTrackerItem('bug-1', true);

    expect(syncTrackerItem).toHaveBeenCalledTimes(1);
  });
});
