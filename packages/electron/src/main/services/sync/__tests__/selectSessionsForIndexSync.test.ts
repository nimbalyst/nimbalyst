// @vitest-environment node
import { expect, it, vi } from 'vitest';

vi.mock('../../../utils/store', () => ({ store: { get: vi.fn(), set: vi.fn() } }));
vi.mock('../../../utils/workspaceDetection', () => ({ resolveProjectPath: vi.fn((path: string) => path) }));

import { selectSessionsForIndexSync } from '../selectSessionsForIndexSync';
import { reconcileSessionIndex } from '../indexReconciliation';
import { createTranscriptBackfill } from '../transcriptBackfill';

it('recovers list entries while leaving held and already-owned transcripts with full backfill', async () => {
  const row = (id: string, workspaceId: string) => ({ id, workspaceId, provider: 'claude-code', title: id, messageCount: 1, createdAt: 1000, updatedAt: 9000 });
  const rows = [row('held', '/held'), row('owed', '/on'), row('fresh', '/on')];
  let state = { projects: ['/held'], sessions: ['owed'] };
  const backfill = createTranscriptBackfill({ read: () => state, write: next => { state = next; } }, path => path);
  const publish = vi.fn(async () => ({ published: true, publishedSessionIds: rows.map(item => item.id) }));
  await reconcileSessionIndex({ onlyMissing: true, syncSessionsToIndex: publish,
    serverIndex: { complete: true, indexProtocolVersion: 2, sessions: [], projects: [] },
    loadLocalSessions: async () => rows, getMessagesForSync: vi.fn(),
    isProjectEnabled: () => true, isMidTurn: () => false, backfill, now: 10000,
  });
  expect(publish).toHaveBeenCalledWith(rows, expect.objectContaining({
    syncMessages: true, messageSyncRequests: [{ sessionId: 'fresh', sinceTimestamp: 0 }],
  }));
  expect(state).toEqual({ projects: ['/held'], sessions: ['owed'] });
});

it('awaits missing-row recovery and preserves newer existing server metadata and tombstones', async () => {
  const local = (id: string, title: string) => ({ id, workspaceId: '/p', provider: 'claude-code', title,
    messageCount: 0, createdAt: 1000, updatedAt: 9000 });
  const missing = local('phone-created', 'Current local title');
  const server = new Map([['existing', { sessionId: 'existing', projectId: '/p', provider: 'claude-code', title: 'Newer remote title', updatedAt: 10000, lastMessageAt: 10000, createdAt: 1000, messageCount: 0 }]]);
  let commit!: () => void;
  const accepted = new Promise<void>(resolve => { commit = resolve; });
  const publish = vi.fn(async (rows: typeof missing[]) => {
    await accepted;
    for (const row of rows) server.set(row.id, { ...row, sessionId: row.id, projectId: row.workspaceId, lastMessageAt: row.updatedAt });
    return { published: true, publishedSessionIds: rows.map(row => row.id) };
  });
  const backfill = createTranscriptBackfill({ read: () => undefined, write: () => {} }, path => path);
  let complete = false;
  const recovery = reconcileSessionIndex({ onlyMissing: true,
    syncSessionsToIndex: publish, serverIndex: { complete: true, indexProtocolVersion: 2,
      sessions: [...server.values()], projects: [], deletedSessionIds: ['deleted'] },
    loadLocalSessions: async () => [missing, local('existing', 'Older local title'), local('deleted', 'Do not revive')],
    getMessagesForSync: vi.fn(), isProjectEnabled: () => true, isMidTurn: () => false, backfill, now: 10000,
  }).then(() => { complete = true; });
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  expect(complete).toBe(false);
  commit();
  await recovery;
  // Read the server fixture after committed publication, not the outgoing payload.
  expect(server.get(missing.id)?.title).toBe('Current local title');
  expect(server.get('existing')?.title).toBe('Newer remote title');
  expect(server.has('deleted')).toBe(false);
  expect(publish.mock.calls[0][0]).toEqual([missing]);
});

it('heals a stale manager after process restart even when parent and activity timestamps match', () => {
  const local = { id: 'child', workspaceId: '/p', provider: 'claude-code', title: 'Child', messageCount: 0, createdAt: 10000, updatedAt: 10000, parentSessionId: 'root', createdBySessionId: 'root' };
  const remote = { ...local, sessionId: 'child', projectId: '/p', lastMessageAt: 10000, createdBySessionId: 'previous-manager' };
  const result = selectSessionsForIndexSync([local], { complete: true, sessions: [remote], projects: [] }, 10000);
  expect(result.sessionsNeedingIndexUpdate).toEqual([local]);
  expect(result.sessionsNeedingMessageSync).toEqual([]);
});

it('republishes a local session whose server row is unreadable under the current key', () => {
  // An undecryptable row carries no value, so the mirror snapshot omits the session and it reads as absent.
  const local = { id: 'old-key', workspaceId: '/p', provider: 'claude-code', title: 'Old', messageCount: 3, createdAt: 5000, updatedAt: 6000 };
  const result = selectSessionsForIndexSync([local], { complete: true, indexProtocolVersion: 2, sessions: [], projects: [] }, 7000);
  expect(result.sessionsNeedingIndexUpdate).toEqual([local]);
});

it('does not re-send a running turn whose server sort timestamp and count are held, but still repairs fields', () => {
  const local = { id: 'running', workspaceId: '/p', provider: 'claude-code', title: 'Run', messageCount: 40, createdAt: 1000, updatedAt: 9000 };
  const remote = { ...local, sessionId: 'running', projectId: '/p', messageCount: 12, updatedAt: 2000, lastMessageAt: 8000 };
  const index = { complete: true, sessions: [remote], projects: [] };
  // Without the predicate this is the mid-turn re-upload: the whole turn goes again.
  expect(selectSessionsForIndexSync([local], index, 9000).sessionsNeedingMessageSync).toEqual(['running']);
  const midTurn = selectSessionsForIndexSync([local], index, 9000, (id) => id === 'running');
  expect(midTurn).toEqual({ sessionsNeedingIndexUpdate: [], sessionsNeedingMessageSync: [] });
  const renamed = selectSessionsForIndexSync([{ ...local, title: 'Renamed' }], index, 9000, () => true);
  expect(renamed.sessionsNeedingIndexUpdate).toHaveLength(1);
  expect(renamed.sessionsNeedingMessageSync).toEqual([]);
});

it('marks listed sessions of projects not enabled once, and uploads a marked transcript from the start once enabled (NIM-7545)', async () => {
  const local = (id: string, workspaceId: string) => ({ id, workspaceId, provider: 'claude-code', title: id, messageCount: 0, createdAt: 1000, updatedAt: 5000 });
  const db = [local('listed-off', '/off'), local('marked-off', '/off'), local('unlisted-off', '/off'), local('marked-on', '/on')];
  const row = (session: ReturnType<typeof local>, extra: Record<string, unknown> = {}) =>
    ({ ...session, sessionId: session.id, projectId: session.workspaceId, lastMessageAt: 5000, ...extra });
  const serverIndex = { complete: true, projects: [], sessions: [
    row(db[0]),
    row(db[1], { transcriptSyncDisabled: true }),
    // Index publishes advanced lastMessageAt while no transcript row was uploaded.
    row(db[3], { transcriptSyncDisabled: true, lastMessageAt: 9000 }),
    // Another desktop's session in a path this one also has: never republished from here.
    { ...row(local('foreign', '/off')) },
  ] };
  const syncSessionsToIndex = vi.fn();
  const loadLocalSessions = vi.fn(async (accept: (workspaceId: string) => boolean) => db.filter(s => accept(s.workspaceId)));
  const memoryBackfill = () => { let state: unknown; return createTranscriptBackfill({ read: () => state, write: next => { state = next; } }, path => path); };
  const input = {
    syncSessionsToIndex, serverIndex, loadLocalSessions, getMessagesForSync: vi.fn(), backfill: memoryBackfill(),
    isProjectEnabled: (workspaceId: string) => workspaceId === '/on', isMidTurn: () => true, now: 10_000,
  };

  await reconcileSessionIndex(input);
  expect(syncSessionsToIndex).toHaveBeenCalledTimes(2);
  // Enabled and marked: full publish plus the whole transcript, even mid-turn.
  expect(syncSessionsToIndex).toHaveBeenCalledWith([db[3]], expect.objectContaining({
    syncMessages: true, messageSyncRequests: [{ sessionId: 'marked-on', sinceTimestamp: 0 }],
  }));
  // Listed without the mark: index row only. Already marked and never-listed sessions cost nothing.
  expect(syncSessionsToIndex).toHaveBeenCalledWith([db[0]], { syncMessages: false });

  // Steady state: every opted-out row is marked, so no opted-out query and no write.
  syncSessionsToIndex.mockClear();
  loadLocalSessions.mockClear();
  const steady = { ...serverIndex, sessions: serverIndex.sessions.filter(s => s.sessionId !== 'foreign')
    .map(s => ({ ...s, lastMessageAt: 5000, transcriptSyncDisabled: s.projectId === '/off' })) };
  // (The marked-on transcript was delivered, so nothing is owed.)
  await reconcileSessionIndex({ ...input, serverIndex: steady, backfill: memoryBackfill() });
  expect(loadLocalSessions).toHaveBeenCalledTimes(1);
  expect(syncSessionsToIndex).not.toHaveBeenCalled();
});

it('re-requests an enabled project\'s earlier transcript from zero until delivery is confirmed, across a restart and after the flag is gone (NIM-7545)', async () => {
  let persisted: unknown;
  const storage = { read: () => persisted, write: (state: unknown) => { persisted = structuredClone(state); } };
  const session = { id: 's', workspaceId: '/on', provider: 'claude-code', title: 's', messageCount: 0, createdAt: 1000, updatedAt: 5000 };
  const serverRow = (extra: Record<string, unknown>) => ({ ...session, sessionId: 's', projectId: '/on', lastMessageAt: 5000, ...extra });
  const index = (row: ReturnType<typeof serverRow>) => ({ complete: true, projects: [], sessions: [row] });
  const syncSessionsToIndex = vi.fn();
  const base = {
    syncSessionsToIndex, getMessagesForSync: vi.fn(), now: 10_000,
    loadLocalSessions: async (accept: (workspaceId: string) => boolean) => [session].filter(s => accept(s.workspaceId)),
    isProjectEnabled: (workspaceId: string) => workspaceId === '/on', isMidTurn: () => false,
  };
  const transcriptRequests = () => syncSessionsToIndex.mock.calls.filter(([, options]) => options?.syncMessages);

  const first = createTranscriptBackfill(storage, path => path);
  await reconcileSessionIndex({ ...base, serverIndex: index(serverRow({ transcriptSyncDisabled: true, lastMessageAt: 9000 })), backfill: first });
  expect(transcriptRequests()).toHaveLength(1);
  expect(transcriptRequests()[0][1].messageSyncRequests).toEqual([{ sessionId: 's', sinceTimestamp: 0 }]);
  // The index row went out, the upload did not.
  transcriptRequests()[0][1].onTranscriptSynced?.('s', { published: false, reason: 'socket closed before the write finished', retryable: true });

  // Restart. The server row no longer says anything is missing.
  syncSessionsToIndex.mockClear();
  const restarted = createTranscriptBackfill(storage, path => path);
  await reconcileSessionIndex({ ...base, serverIndex: index(serverRow({})), backfill: restarted });
  expect(transcriptRequests()).toHaveLength(1);
  expect(transcriptRequests()[0][1].messageSyncRequests).toEqual([{ sessionId: 's', sinceTimestamp: 0 }]);
  // The session keeps its mark until the history is delivered...
  expect(restarted.isWithheld('/on', 's')).toBe(true);
  transcriptRequests()[0][1].onTranscriptSynced?.('s', { published: true });
  // ...then the mark is cleared with an index-only republish, and nothing more is owed.
  expect(restarted.isWithheld('/on', 's')).toBe(false);
  expect(syncSessionsToIndex).toHaveBeenLastCalledWith([session], { syncMessages: false });
  syncSessionsToIndex.mockClear();
  await reconcileSessionIndex({ ...base, serverIndex: index(serverRow({})), backfill: createTranscriptBackfill(storage, path => path) });
  expect(syncSessionsToIndex).not.toHaveBeenCalled();
});
