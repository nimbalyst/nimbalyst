import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
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
  getCurrentIdentity: () => ({ email: 'human@example.com', displayName: 'Human Editor' }),
}));

vi.mock('../../utils/store', () => ({
  getWorkspaceState: () => ({}),
  isAnalyticsEnabled: () => true,
}));

vi.mock('@nimbalyst/runtime/plugins/TrackerPlugin/models/TrackerDataModel', () => ({
  globalRegistry: { get: vi.fn(() => undefined) },
}));

import { ElectronDocumentService } from '../ElectronDocumentService';

let tempDir: string;
let service: ElectronDocumentService;

function nativeRow(data: Record<string, unknown>) {
  return {
    id: 'bug-1',
    type: 'bug',
    source: 'native',
    source_ref: null,
    document_path: null,
    workspace: tempDir,
    data: JSON.stringify(data),
    sync_status: 'local',
    last_indexed: new Date().toISOString(),
    body_version: 0,
    archived: false,
  };
}

function installStatefulTrackerRow(initialData: Record<string, unknown>) {
  const state: { row: ReturnType<typeof nativeRow> & { content?: string | null } } = {
    row: nativeRow(initialData),
  };
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT')) {
      return { rows: [state.row] };
    }
    if (normalized.startsWith('UPDATE tracker_items SET data = $1')) {
      state.row = { ...state.row, data: params?.[0] as string };
      return { rows: [state.row] };
    }
    if (normalized.startsWith('UPDATE tracker_items SET content = $1')) {
      state.row = {
        ...state.row,
        content: params?.[0] as string,
        data: params?.[1] as string,
        body_version: state.row.body_version + 1,
      };
      return { rows: [state.row] };
    }
    if (normalized.startsWith('INSERT INTO tracker_body_cache')) {
      return { rows: [] };
    }
    throw new Error(`Unexpected query in test: ${normalized}`);
  });
  return state;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-activity-history-test-'));
  service = new ElectronDocumentService(tempDir);
});

afterEach(async () => {
  service.destroy();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('direct UI tracker activity history', () => {
  it('records an attributed before/after entry for a manual status edit', async () => {
    const original = nativeRow({ title: 'Example bug', status: 'to-do', activity: [] });
    const persisted = nativeRow({ title: 'Example bug', status: 'in-progress', activity: [] });
    mockQuery.mockResolvedValueOnce({ rows: [original] });
    mockQuery.mockResolvedValueOnce({ rows: [persisted] });

    await service.updateTrackerItem('bug-1', { status: 'in-progress' });

    const writtenData = JSON.parse(mockQuery.mock.calls[1][1][0]);
    expect(writtenData.activity).toHaveLength(1);
    expect(writtenData.activity[0]).toMatchObject({
      authorIdentity: { email: 'human@example.com', displayName: 'Human Editor' },
      action: 'status_changed',
      field: 'status',
      oldValue: 'to-do',
      newValue: 'in-progress',
    });
  });

  it('records an attributed activity entry for a manual content edit', async () => {
    const original = nativeRow({ title: 'Example bug', status: 'to-do', activity: [] });
    const persisted = nativeRow({ title: 'Example bug', status: 'to-do', activity: [] });
    mockQuery.mockResolvedValueOnce({ rows: [original] });
    mockQuery.mockResolvedValueOnce({ rows: [{ ...persisted, body_version: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await service.updateTrackerItemContent('bug-1', { root: { type: 'root' } });

    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[0]).toContain('data = $2');
    const writtenData = JSON.parse(updateCall[1][1]);
    expect(writtenData.activity).toHaveLength(1);
    expect(writtenData.activity[0]).toMatchObject({
      authorIdentity: { email: 'human@example.com', displayName: 'Human Editor' },
      action: 'updated',
      field: 'content',
    });
  });

  it('records attributed before/after history for archive changes', async () => {
    const original = nativeRow({ title: 'Example bug', status: 'to-do', activity: [] });
    const persisted = { ...original, archived: true };
    mockQuery.mockResolvedValueOnce({ rows: [original] });
    mockQuery.mockResolvedValueOnce({ rows: [persisted] });

    await service.archiveTrackerItem('bug-1', true);

    const updateCall = mockQuery.mock.calls[1];
    const writtenData = JSON.parse(updateCall[1][0]);
    expect(writtenData.activity).toHaveLength(1);
    expect(writtenData.activity[0]).toMatchObject({
      authorIdentity: { email: 'human@example.com', displayName: 'Human Editor' },
      action: 'archived',
      field: 'archived',
      oldValue: 'false',
      newValue: 'true',
    });
  });

  it('coalesces consecutive content saves by the same author into one latest entry', async () => {
    const state = installStatefulTrackerRow({ title: 'Example bug', status: 'to-do', activity: [] });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      await service.updateTrackerItemContent('bug-1', { root: { text: 'one' } });
      vi.setSystemTime(2_000);
      await service.updateTrackerItemContent('bug-1', { root: { text: 'two' } });
      vi.setSystemTime(3_000);
      await service.updateTrackerItemContent('bug-1', { root: { text: 'three' } });
    } finally {
      vi.useRealTimers();
    }

    const activity = JSON.parse(state.row.data).activity;
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      authorIdentity: { email: 'human@example.com', displayName: 'Human Editor' },
      action: 'updated',
      field: 'content',
      timestamp: 3_000,
    });
  });

  it('coalesces consecutive same-field edits into one net before/after entry', async () => {
    const state = installStatefulTrackerRow({
      title: 'Example bug',
      status: 'to-do',
      priority: 'low',
      activity: [],
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      await service.updateTrackerItem('bug-1', { priority: 'medium' });
      vi.setSystemTime(2_000);
      await service.updateTrackerItem('bug-1', { priority: 'high' });
      vi.setSystemTime(3_000);
      await service.updateTrackerItem('bug-1', { priority: 'critical' });
    } finally {
      vi.useRealTimers();
    }

    const activity = JSON.parse(state.row.data).activity;
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      authorIdentity: { email: 'human@example.com', displayName: 'Human Editor' },
      action: 'updated',
      field: 'priority',
      oldValue: 'low',
      newValue: 'critical',
      timestamp: 3_000,
    });
  });
});
