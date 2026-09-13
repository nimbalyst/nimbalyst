// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  receipt: vi.fn(),
  setStatus: vi.fn(),
  policy: vi.fn(),
  shouldSync: vi.fn(),
  sync: vi.fn(),
  active: vi.fn(),
  onApplied: vi.fn(),
  ensureRoom: vi.fn(),
  initialize: vi.fn(),
  team: vi.fn(),
  load: vi.fn(),
  enqueue: vi.fn(),
  drain: vi.fn(),
}));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({
  database: { query: mocks.query },
}));
vi.mock('../trackerCreationReceipt', async (original) => ({
  ...(await original<any>()),
  getCreationReceipt: mocks.receipt,
  setCreationPublication: mocks.setStatus,
}));
vi.mock('../../TrackerPolicyService', () => ({
  resolveTrackerSharingPolicy: mocks.policy,
  shouldSyncTrackerItem: mocks.shouldSync,
}));
vi.mock('../../TrackerSyncManager', () => ({
  syncTrackerItem: mocks.sync,
  isTrackerSyncActive: mocks.active,
  onTrackerItemApplied: mocks.onApplied,
}));
vi.mock('../../MainBodyDocService', () => ({
  ensureHeadlessBodyRoom: mocks.ensureRoom,
  initializeHeadlessBodyMarkdown: mocks.initialize,
}));
vi.mock('../../TeamService', () => ({ findTeamForWorkspace: mocks.team }));
vi.mock('../../StytchAuthService', () => ({
  getPersonalUserId: () => 'account-1',
}));
vi.mock('../../CollabAssetStore', () => ({
  getCollabAssetStore: () => ({
    loadAsset: mocks.load,
    enqueueUpload: mocks.enqueue,
  }),
}));
vi.mock('../../CollabAssetOutboxDrainCoordinator', () => ({
  getCollabAssetOutboxDrainCoordinator: () => ({ drainNow: mocks.drain }),
}));
import {
  getTrackerCreationPublication,
  publishPendingTrackerCreations,
  publishTrackerCreation,
} from '../publishTrackerCreation';

let workspace: string;
let body: string;
const deps = { getItem: vi.fn(), ackTimeoutMs: 30 };
beforeEach(async () => {
  vi.resetAllMocks();
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tracker-publication-'));
  body = 'Saved **body** Ω';
  mocks.onApplied.mockReturnValue(() => {});
  mocks.receipt.mockResolvedValue({ publication_status: 'pending' });
  mocks.policy.mockReturnValue({ known: true, policy: {} });
  mocks.shouldSync.mockReturnValue(true);
  mocks.active.mockReturnValue(true);
  mocks.query.mockImplementation(async () => ({
    rows: [{ content: JSON.stringify(body) }],
  }));
  mocks.team.mockResolvedValue({ orgId: 'team-1' });
  deps.getItem.mockImplementation(async (id) => ({
    id,
    workspace,
    type: 'task',
    syncStatus: 'synced',
  }));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('creation publication', () => {
  it.each(['personal', 'unpublished draft'])(
    'keeps a %s local without body or asset traffic',
    async () => {
      mocks.shouldSync.mockReturnValue(false);
      expect(
        await publishTrackerCreation(workspace, 'item', deps),
      ).toMatchObject({ status: 'local' });
      expect(mocks.sync).not.toHaveBeenCalled();
      expect(mocks.initialize).not.toHaveBeenCalled();
      expect(mocks.team).not.toHaveBeenCalled();
      expect(mocks.drain).not.toHaveBeenCalled();
    },
  );

  it('keeps publication pending when sharing policy is unknown or sync is offline', async () => {
    mocks.policy.mockReturnValueOnce({ known: false });
    expect(await publishTrackerCreation(workspace, 'item', deps)).toMatchObject(
      { status: 'pending', error: expect.stringContaining('not loaded') },
    );
    mocks.active.mockReturnValue(false);
    expect(await publishTrackerCreation(workspace, 'item', deps)).toMatchObject(
      { status: 'pending', error: expect.stringContaining('not connected') },
    );
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it('retains the original snapshot after metadata succeeds but body acknowledgment fails', async () => {
    mocks.initialize.mockRejectedValueOnce(new Error('Acknowledgment lost'));
    expect(await publishTrackerCreation(workspace, 'item', deps)).toMatchObject(
      { status: 'pending', error: 'Acknowledgment lost' },
    );
    expect(mocks.setStatus).not.toHaveBeenCalledWith(
      workspace,
      'item',
      'published',
    );
    expect(
      await getTrackerCreationPublication(workspace, 'item'),
    ).toMatchObject({ status: 'pending', savedContent: body });
    expect(await publishTrackerCreation(workspace, 'item', deps)).toMatchObject(
      { status: 'published' },
    );
    expect(mocks.initialize).toHaveBeenNthCalledWith(
      2,
      workspace,
      'item',
      body,
    );
    // The publisher reads the initial cache; it never writes over the local body.
    expect(
      mocks.query.mock.calls.every(([sql]) => sql.startsWith('SELECT')),
    ).toBe(true);
  });

  it('preserves newer local edits instead of publishing the older creation snapshot', async () => {
    deps.getItem.mockResolvedValue({
      id: 'item',
      workspace,
      type: 'task',
      syncStatus: 'synced',
      bodyVersion: 2,
      content: 'Later edits',
    });
    expect(await publishTrackerCreation(workspace, 'item', deps)).toMatchObject(
      { status: 'pending', error: expect.stringContaining('newer edits') },
    );
    expect(mocks.initialize).not.toHaveBeenCalled();
  });

  it('does not report publication complete when metadata is still pending', async () => {
    deps.getItem.mockImplementation(async (id) => ({
      id,
      workspace,
      type: 'task',
      syncStatus: 'pending',
    }));
    expect(await publishTrackerCreation(workspace, 'item', deps)).toMatchObject(
      {
        status: 'pending',
        error: expect.stringContaining('metadata is not yet acknowledged'),
      },
    );
    expect(mocks.initialize).toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalledWith(
      workspace,
      'item',
      'published',
    );
    // The listener is released whether or not the echo arrived.
    expect(mocks.onApplied).toHaveBeenCalledTimes(1);
  });

  it('waits for the room applied echo instead of judging the row the moment the upsert is queued', async () => {
    // `syncTrackerItem` returns once the mutation is on the socket; the row only
    // reads `synced` after the echo. Without the wait, a body-less creation
    // fails every first attempt.
    let status = 'pending';
    let listener: ((workspace: string, applied: { itemId: string }) => void) | null = null;
    mocks.onApplied.mockImplementation((cb) => {
      listener = cb;
      return () => { listener = null; };
    });
    deps.getItem.mockImplementation(async (id) => ({ id, workspace, type: 'task', syncStatus: status }));
    mocks.sync.mockImplementation(async () => {
      setTimeout(() => {
        status = 'synced';
        listener?.(workspace, { itemId: 'item' });
      }, 5);
    });
    mocks.query.mockResolvedValue({ rows: [] });
    deps.getItem.mockImplementation(async (id) => ({ id, workspace, type: 'task', syncStatus: status, bodyVersion: 0 }));
    expect(await publishTrackerCreation(workspace, 'item', deps)).toMatchObject({ status: 'published' });
    expect(listener).toBeNull();
  });

  it('resumes every pending creation for a workspace, continuing past one refusal', async () => {
    mocks.query.mockImplementation(async (sql: string) =>
      sql.includes('tracker_creation_receipts')
        ? { rows: [{ item_id: 'first' }, { item_id: 'second' }] }
        : { rows: [{ content: JSON.stringify(body) }] },
    );
    mocks.initialize
      .mockRejectedValueOnce(new Error('Acknowledgment lost'))
      .mockResolvedValueOnce(undefined);
    const results = await publishPendingTrackerCreations(workspace, deps);
    expect(results).toMatchObject([
      { itemId: 'first', status: 'pending', error: 'Acknowledgment lost' },
      { itemId: 'second', status: 'published' },
    ]);
    expect(mocks.query.mock.calls[0][0]).toContain("publication_status = 'pending'");
  });

  it('treats numeric-looking and explicitly empty Markdown as body strings', async () => {
    for (body of ['123', '']) {
      await publishTrackerCreation(workspace, 'item', deps);
      expect(mocks.initialize).toHaveBeenLastCalledWith(
        workspace,
        'item',
        body,
      );
    }
  });

  it('waits for durable image delivery and reuses the same asset identity on retry', async () => {
    await fs.mkdir(path.join(workspace, '.nimbalyst/assets'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspace, '.nimbalyst/assets/screen.png'),
      Buffer.from([137, 80, 78, 71]),
    );
    body = 'Screenshot\n\n![screen](.nimbalyst/assets/screen.png)';
    mocks.load
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ uploadState: 'queued' });
    expect(await publishTrackerCreation(workspace, 'item', deps)).toMatchObject(
      { status: 'pending' },
    );
    expect(mocks.initialize).not.toHaveBeenCalled();
    // The body room must be opened before the first asset request addresses
    // it, or the room remembers a truncated id and refuses every later upgrade.
    expect(mocks.ensureRoom.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.enqueue.mock.invocationCallOrder[0],
    );
    const identity = mocks.enqueue.mock.calls[0][0].identity;
    expect(identity).toMatchObject({
      accountId: 'account-1',
      orgId: 'team-1',
      documentId: 'tracker-content/item',
    });
    mocks.load.mockResolvedValue({ uploadState: 'cached' });
    expect(await publishTrackerCreation(workspace, 'item', deps)).toMatchObject(
      { status: 'published' },
    );
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.drain).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenLastCalledWith(identity);
    expect(mocks.initialize).toHaveBeenLastCalledWith(
      workspace,
      'item',
      expect.stringContaining(
        `collab-asset://doc/tracker-content%2Fitem/asset/${identity.assetId}`,
      ),
    );
  });

  it('rejects screenshots escaping the workspace through a symlink', async () => {
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tracker-outside-'),
    );
    try {
      await fs.writeFile(path.join(outside, 'private.png'), 'outside bytes');
      await fs.symlink(outside, path.join(workspace, 'assets'));
      body = '![screen](assets/private.png)';
      expect(
        await publishTrackerCreation(workspace, 'item', deps),
      ).toMatchObject({
        status: 'pending',
        error: expect.stringContaining('outside this workspace'),
      });
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(mocks.initialize).not.toHaveBeenCalled();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
