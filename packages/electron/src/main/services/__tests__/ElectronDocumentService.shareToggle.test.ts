/**
 * Unit test for the per-item "Share with team" toggle reconciliation
 * (ElectronDocumentService.reconcileItemShare), the backend behind the tracker
 * UI Share button. Verifies that flipping the share flag pushes to / tombstones
 * from the team room correctly across the live/offline matrix -- without a
 * restart.
 *
 * Mocks: database, TrackerSyncManager, store, registry.
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

let tempDir: string;
let service: ElectronDocumentService;

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetWorkspaceState.mockReturnValue({});
  // Plan-like hybrid type: shares per-item.
  mockGlobalRegistryGet.mockReturnValue({ sync: { mode: 'hybrid', scope: 'project' } });
  mockQuery.mockResolvedValue({ rows: [] });
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'share-toggle-test-'));
  service = new ElectronDocumentService(tempDir);
});

afterEach(async () => {
  service?.destroy();
  await fs.rm(tempDir, { recursive: true, force: true });
});

const ROW_ID = 'pln_abc123';

function makeItem(shared: boolean) {
  return {
    id: ROW_ID,
    type: 'plan',
    workspace: tempDir,
    customFields: shared ? { share: { status: 'team', body: 'team' } } : { share: { status: 'private', body: 'private' } },
  } as any;
}

function reconcile(item: any, nowShared: boolean) {
  return (service as any).reconcileItemShare(item, ROW_ID, nowShared);
}

describe('reconcileItemShare', () => {
  it('share + sync live: pushes the item to the team room', async () => {
    (isTrackerSyncActive as any).mockReturnValue(true);
    await reconcile(makeItem(true), true);
    expect(syncTrackerItem).toHaveBeenCalledTimes(1);
    expect(unsyncTrackerItem).not.toHaveBeenCalled();
    // No local sync_status write on the live-share path.
    const statusWrites = mockQuery.mock.calls.filter(c => /sync_status/.test(c[0]));
    expect(statusWrites).toHaveLength(0);
  });

  it('share + offline: marks the row pending for the reconnect backfill', async () => {
    (isTrackerSyncActive as any).mockReturnValue(false);
    await reconcile(makeItem(true), true);
    expect(syncTrackerItem).not.toHaveBeenCalled();
    const pendingWrite = mockQuery.mock.calls.find(c => /sync_status = 'pending'/.test(c[0]));
    expect(pendingWrite).toBeTruthy();
    expect(pendingWrite![1]).toEqual([ROW_ID]);
  });

  it('unshare + sync live: removes from the room and resets the row to local', async () => {
    (isTrackerSyncActive as any).mockReturnValue(true);
    await reconcile(makeItem(false), false);
    expect(unsyncTrackerItem).toHaveBeenCalledWith(ROW_ID, tempDir);
    expect(syncTrackerItem).not.toHaveBeenCalled();
    const resetWrite = mockQuery.mock.calls.find(c => /sync_status = 'local', sync_id = NULL/.test(c[0]));
    expect(resetWrite).toBeTruthy();
    expect(resetWrite![1]).toEqual([ROW_ID]);
  });

  it('unshare + offline: marks pending so the backfill tombstones it', async () => {
    (isTrackerSyncActive as any).mockReturnValue(false);
    await reconcile(makeItem(false), false);
    expect(unsyncTrackerItem).not.toHaveBeenCalled();
    const pendingWrite = mockQuery.mock.calls.find(c => /sync_status = 'pending'/.test(c[0]));
    expect(pendingWrite).toBeTruthy();
  });

  it('respects a local-mode type: never pushes even when flagged', async () => {
    mockGlobalRegistryGet.mockReturnValue({ sync: { mode: 'local', scope: 'project' } });
    (isTrackerSyncActive as any).mockReturnValue(true);
    await reconcile(makeItem(true), true);
    expect(syncTrackerItem).not.toHaveBeenCalled();
  });
});

describe('setTrackerItemShared (file-backed routing)', () => {
  const REL = 'plans/example.md';
  const FM_ID = `fm:plan:${REL}`;

  async function seedPlanFile(): Promise<string> {
    const dir = path.join(tempDir, 'plans');
    await fs.mkdir(dir, { recursive: true });
    const fullPath = path.join(dir, 'example.md');
    await fs.writeFile(
      fullPath,
      '---\nplanStatus:\n  planId: p1\n  title: Example\n  status: draft\n---\n## Body\n\nDetails.\n',
      'utf-8',
    );
    return fullPath;
  }

  it('writes ONLY the top-level share key to the file, preserving planStatus, and reconciles', async () => {
    const fullPath = await seedPlanFile();
    const fmRow = { id: FM_ID, source: 'frontmatter', source_ref: REL, document_path: REL, type: 'plan', data: '{}', workspace: tempDir };
    vi.spyOn(service as any, 'resolveTrackerRowForPublicId').mockResolvedValue(fmRow);
    // DB writes/reads: UPDATE + SELECT (pre) + SELECT (final). rowToTrackerItem
    // needs a row shape back.
    mockQuery.mockResolvedValue({ rows: [{ id: FM_ID, type: 'plan', source: 'frontmatter', source_ref: REL, workspace: tempDir, data: JSON.stringify({ share: { status: 'team', body: 'team' } }), sync_status: 'pending', last_indexed: new Date().toISOString() }] });
    const reconcileFm = vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(undefined);

    await service.setTrackerItemShared(FM_ID, true);

    const written = await fs.readFile(fullPath, 'utf-8');
    expect(written).toContain('share:');
    expect(written).toContain('status: team');
    // planStatus block is preserved, NOT flattened to trackerStatus.
    expect(written).toContain('planStatus:');
    expect(written).not.toContain('trackerStatus:');
    // Room push reconciled explicitly with nowShared=true.
    expect(reconcileFm).toHaveBeenCalledWith(expect.anything(), FM_ID, REL, true);
  });

  it('removes the share key from the file on unshare and reconciles with nowShared=false', async () => {
    const fullPath = await seedPlanFile();
    // Start from a shared file.
    await fs.writeFile(
      fullPath,
      '---\nplanStatus:\n  planId: p1\n  title: Example\n  status: draft\nshare:\n  status: team\n  body: team\n---\n## Body\n',
      'utf-8',
    );
    const fmRow = { id: FM_ID, source: 'frontmatter', source_ref: REL, document_path: REL, type: 'plan', data: JSON.stringify({ share: { status: 'team', body: 'team' } }), workspace: tempDir };
    vi.spyOn(service as any, 'resolveTrackerRowForPublicId').mockResolvedValue(fmRow);
    mockQuery.mockResolvedValue({ rows: [{ id: FM_ID, type: 'plan', source: 'frontmatter', source_ref: REL, workspace: tempDir, data: '{}', sync_status: 'local', last_indexed: new Date().toISOString() }] });
    const reconcileFm = vi.spyOn(service as any, 'reconcileFrontmatterShare').mockResolvedValue(undefined);

    await service.setTrackerItemShared(FM_ID, false);

    const written = await fs.readFile(fullPath, 'utf-8');
    expect(written).not.toContain('share:');
    expect(written).toContain('planStatus:');
    expect(reconcileFm).toHaveBeenCalledWith(expect.anything(), FM_ID, REL, false);
  });
});

describe('setTrackerItemShared (native unshare guard)', () => {
  it('refuses to unshare a native item (would delete it)', async () => {
    const nativeRow = { id: 'pln_native1', source: 'native', source_ref: null, document_path: null, type: 'plan', data: JSON.stringify({ share: { status: 'team', body: 'team' } }), workspace: tempDir };
    vi.spyOn(service as any, 'resolveTrackerRowForPublicId').mockResolvedValue(nativeRow);
    await expect(service.setTrackerItemShared('pln_native1', false)).rejects.toThrow(/not supported/i);
  });
});
