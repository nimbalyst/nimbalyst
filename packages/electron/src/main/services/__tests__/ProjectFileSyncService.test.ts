import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { mkdtemp, writeFile, rm } from 'fs/promises';

// SyncManager pulls in heavy main-process wiring; stub the only function the
// service touches at import/runtime so the unit can construct in isolation.
vi.mock('../SyncManager', () => ({
  getPersonalDocSyncConfig: () => null,
}));

// In-memory stand-in for the durable baseline table (project_file_sync_baseline),
// shared by the mocked `database` below. Cleared per-test where it matters.
const dbBaselineStore = vi.hoisted(() => new Map<string, {
  project_id: string; sync_id: string; content_hash: string; last_synced_mtime: number;
}>());

vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: vi.fn(async (sql: string, params: any[] = []) => {
      const s = sql.trim();
      if (s.startsWith('INSERT INTO project_file_sync_baseline')) {
        const [project_id, sync_id, content_hash, last_synced_mtime] = params;
        dbBaselineStore.set(`${project_id}|${sync_id}`, { project_id, sync_id, content_hash, last_synced_mtime });
        return { rows: [] };
      }
      if (s.startsWith('SELECT') && s.includes('project_file_sync_baseline')) {
        const [project_id] = params;
        return { rows: [...dbBaselineStore.values()].filter((r) => r.project_id === project_id) };
      }
      if (s.startsWith('DELETE FROM project_file_sync_baseline')) {
        const [project_id, sync_id] = params;
        dbBaselineStore.delete(`${project_id}|${sync_id}`);
        return { rows: [] };
      }
      return { rows: [] };
    }),
  },
}));

import { ProjectFileSyncService } from '../ProjectFileSyncService';
import { dirtyEditorRegistry } from '../DirtyEditorRegistry';
import { logger } from '../../utils/logger';

/** Provider push stubs that report every file stored, like a server ack. */
const ackContent = async (_projectId: string, syncId: string) => ({ stored: [syncId], rejected: [], unconfirmed: [] });
const ackBatch = async (_projectId: string, files: Array<{ syncId: string }>) => ({
  stored: files.map((f) => f.syncId), rejected: [], unconfirmed: [],
});

/** Deterministic syncId derivation -- must match ProjectFileSyncService.syncIdFromPath. */
function syncIdFromPath(relativePath: string): string {
  return createHash('sha256').update(relativePath).digest('hex');
}

describe('ProjectFileSyncService.handleFileSaved', () => {
  let tmpDir: string;
  let service: ProjectFileSyncService;
  let pushFileContent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pfs-test-'));
    service = new ProjectFileSyncService();

    pushFileContent = vi.fn(ackContent);
    // Inject a mock provider so no real WebSocket / encryption is needed.
    (service as any).provider = { pushFileContent };

    // Simulate a project that completed its startup sweep: the file-map cache
    // exists (keyed by encryptedProjectId) and a project state map is present.
    (service as any)._fileMapCache = new Map<string, { fileMap: Map<string, string>; workspacePath: string }>();
    (service as any)._fileMapCache.set('proj-enc', { fileMap: new Map<string, string>(), workspacePath: tmpDir });
    (service as any).projectStates.set('proj-enc', new Map());
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('pushes a newly created markdown file to the server', async () => {
    const fsp = await import('fs/promises');
    const filePath = path.join(tmpDir, 'design', 'new-doc.md');
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '# Hello\n', 'utf-8');

    await service.handleFileSaved(filePath, tmpDir, 'proj-enc');

    expect(pushFileContent).toHaveBeenCalledTimes(1);
  });

  it('registers the newly created file in the project file-map for remote round-trips', async () => {
    const fsp = await import('fs/promises');
    const filePath = path.join(tmpDir, 'design', 'round-trip.md');
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '# Round trip\n', 'utf-8');

    await service.handleFileSaved(filePath, tmpDir, 'proj-enc');

    const relativePath = path.relative(tmpDir, filePath);
    const syncId = syncIdFromPath(relativePath);
    const cache = (service as any)._fileMapCache.get('proj-enc') as { fileMap: Map<string, string> };

    // The new file must be discoverable by syncId so a later remote delete /
    // update from mobile can be applied to the correct local path.
    expect(cache.fileMap.get(syncId)).toBe(filePath);
  });
});

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * NIM-853 regression: the personal docs sync (System A) must never overwrite a
 * newer local file with an older server snapshot. The reported data loss came
 * from a stale reconnect manifest causing the server to push its older copy
 * back in `updatedFiles`, which `writeRemoteFileToDisk` then applied blindly.
 */
describe('ProjectFileSyncService remote-write conflict guard', () => {
  let tmpDir: string;
  let service: ProjectFileSyncService;
  let pushFileBatch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pfs-guard-'));
    service = new ProjectFileSyncService();

    pushFileBatch = vi.fn(ackBatch);
    (service as any).provider = {
      pushFileContent: vi.fn(ackContent),
      pushFileBatch,
    };
    (service as any)._fileMapCache = new Map<string, { fileMap: Map<string, string>; workspacePath: string }>();
    (service as any)._fileMapCache.set('proj-enc', { fileMap: new Map<string, string>(), workspacePath: tmpDir });
    (service as any).projectStates.set('proj-enc', new Map());
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Seed the on-disk file + baseline + file-map for a synced file. */
  async function seedSyncedFile(relPath: string, baselineContent: string, baselineMtime: number) {
    const fsp = await import('fs/promises');
    const filePath = path.join(tmpDir, relPath);
    const syncId = syncIdFromPath(relPath);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, baselineContent, 'utf-8');
    await fsp.utimes(filePath, new Date(baselineMtime), new Date(baselineMtime));
    (service as any).projectStates.get('proj-enc').set(syncId, {
      syncId,
      contentHash: sha256(baselineContent),
      lastSyncedMtime: baselineMtime,
    });
    (service as any)._fileMapCache.get('proj-enc').fileMap.set(syncId, filePath);
    return { filePath, syncId };
  }

  it('does not overwrite a newer local file with an older remote snapshot', async () => {
    const fsp = await import('fs/promises');
    const relPath = path.join('planning', 'big.md');
    const oldMtime = Date.now() - 60_000;
    const oldContent = '# Old\n' + 'x'.repeat(100);
    const { filePath, syncId } = await seedSyncedFile(relPath, oldContent, oldMtime);

    // Local edits land: much larger + newer on disk than the baseline.
    const newContent = '# New\n' + 'y'.repeat(5000);
    const newMtime = Date.now();
    await writeFile(filePath, newContent, 'utf-8');
    await fsp.utimes(filePath, new Date(newMtime), new Date(newMtime));

    // Server replays its OLD copy (stale-manifest scenario).
    const response = {
      updatedFiles: [{
        syncId,
        relativePath: relPath,
        title: 'big',
        content: oldContent,
        contentHash: sha256(oldContent),
        lastModifiedAt: oldMtime,
        hasYjs: false,
      }],
      newFiles: [],
      deletedSyncIds: [],
      needFromClient: [],
      yjsUpdates: [],
    };

    await (service as any).handleSyncResponse('proj-enc', response);

    const after = await fsp.readFile(filePath, 'utf-8');
    expect(after).toBe(newContent);
  });
});

/**
 * Push acks over the real provider and a fake socket, so the baseline the guard
 * consults is whatever the provider's outcome actually produced. A server that
 * predates `fileContentPushAck` never answers a push; one that acks can still
 * lose an ack with its connection.
 */
describe('ProjectFileSyncService push acks over a live provider', () => {
  class FakeSocket {
    static OPEN = 1;
    static last: FakeSocket;
    readyState = FakeSocket.OPEN;
    sent: any[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { FakeSocket.last = this; }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  // Bounded by time, not loop turns: the encryption behind each send runs on the
  // threadpool, and under a loaded full-suite run 200 turns could pass before the
  // request was sent, leaving `request` undefined.
  const settle = async (done: () => boolean) => {
    const deadline = Date.now() + 4_000;
    while (!done() && Date.now() < deadline) await new Promise((r) => setImmediate(r));
  };
  /** Let already-queued async work run for a fixed number of turns. */
  const drain = async () => {
    for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
  };
  const rel = 'note.md';
  const syncId = syncIdFromPath(rel);
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pfs-ack-'));
    filePath = path.join(tmpDir, rel);
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** A synced note at A, connected, with the server's first answer advertising acks or not. */
  async function connected(pushAck: boolean) {
    const fsp = await import('fs/promises');
    const { ProjectSyncProvider } = await import('@nimbalyst/runtime/sync');
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const encrypt = async (text: string) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
      return { encrypted: Buffer.from(data).toString('base64'), iv: Buffer.from(iv).toString('base64') };
    };
    /** The wire entry another device's write of `content` produces. */
    const remoteEntry = async (content: string) => {
      const [c, p, t] = await Promise.all([encrypt(content), encrypt(rel), encrypt('note')]);
      return {
        syncId, encryptedContent: c.encrypted, contentIv: c.iv, contentHash: sha256(content), encryptedPath: p.encrypted,
        pathIv: p.iv, encryptedTitle: t.encrypted, titleIv: t.iv, lastModifiedAt: Date.now() + 60_000, hasYjs: false,
      };
    };
    const provider = new ProjectSyncProvider({
      serverUrl: 'https://sync.test', orgId: 'org', personalMemberId: 'member' as any, encryptionKey: key, getJwt: async () => 'jwt' as any,
    });
    const service = new ProjectFileSyncService();
    (service as any).provider = provider;
    provider.onSyncResponse((projectId, response) => (service as any).handleSyncResponse(projectId, response));
    provider.onFileUpdate((projectId, file) => (service as any).handleRemoteFileUpdate(projectId, file));

    const t0 = Date.now() - 120_000;
    await writeFile(filePath, 'A', 'utf-8');
    await fsp.utimes(filePath, new Date(t0), new Date(t0));
    (service as any).projectStates.set('proj-enc', new Map([[syncId, { syncId, contentHash: sha256('A'), lastSyncedMtime: t0 }]]));
    (service as any)._fileMapCache = new Map([['proj-enc', { fileMap: new Map([[syncId, filePath]]), workspacePath: tmpDir }]]);

    await provider.connect('proj-enc', () => (service as any).buildManifest(tmpDir, 'proj-enc', { seedBaseline: false }));
    const open = async () => {
      const ws = FakeSocket.last;
      ws.onopen!();
      await settle(() => ws.sent.some((m) => m.type === 'projectSyncRequest'));
      return { ws, request: ws.sent.find((m) => m.type === 'projectSyncRequest') };
    };
    const { ws } = await open();
    ws.onmessage!({ data: JSON.stringify({ type: 'projectSyncResponse', ...(pushAck ? { pushAck } : {}), updatedFiles: [], newFiles: [], yjsUpdates: [], needFromClient: [], deletedSyncIds: [] }) });

    /** Save B, then lose the connection before any ack. */
    const saveBAndDrop = async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await writeFile(filePath, 'B', 'utf-8');
      const saved = service.handleFileSaved(filePath, tmpDir, 'proj-enc');
      await settle(() => ws.sent.some((m) => m.type === 'fileContentPush'));
      ws.onclose!();
      await saved;
      await vi.advanceTimersByTimeAsync(30_000); // reconnect backoff
      vi.useRealTimers();
      expect(FakeSocket.last).not.toBe(ws);
      return open();
    };
    const mdContents = async () => Promise.all((await fsp.readdir(tmpDir)).filter((f) => f.endsWith('.md')).sort()
      .map((f) => fsp.readFile(path.join(tmpDir, f), 'utf-8')));
    return { fsp, provider, service, ws, remoteEntry, saveBAndDrop, mdContents };
  }

  const response = (extra: object) => ({ data: JSON.stringify({
    type: 'projectSyncResponse', pushAck: true, updatedFiles: [], newFiles: [], yjsUpdates: [], needFromClient: [], deletedSyncIds: [], ...extra,
  }) });

  it('keeps a later mobile edit after a save the server stored without acking', async () => {
    const { fsp, provider, service, ws, remoteEntry } = await connected(false);

    // Save A -> B. The server stores it and, being old, sends nothing back.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await writeFile(filePath, 'B', 'utf-8');
    const saved = service.handleFileSaved(filePath, tmpDir, 'proj-enc');
    await settle(() => ws.sent.some((m) => m.type === 'fileContentPush'));
    await vi.advanceTimersByTimeAsync(60_000);
    await saved;
    vi.useRealTimers();

    // Mobile then edits the stored B into C.
    ws.sent = [];
    ws.onmessage!({ data: JSON.stringify({ type: 'fileContentBroadcast', ...(await remoteEntry('C')), fromConnectionId: 'mobile' }) });

    await vi.waitFor(async () => expect(await fsp.readFile(filePath, 'utf-8')).toBe('C'));
    expect(ws.sent.filter((m) => m.type === 'fileContentPush')).toEqual([]);
    provider.disconnectAll();
  });

  it('keeps both sides when a lost ack hid a failed store and another device wrote meanwhile', async () => {
    const { fsp, provider, remoteEntry, saveBAndDrop, mdContents } = await connected(true);
    // The server failed to store B; its rejection ack went down with the socket.
    const { ws, request } = await saveBAndDrop();
    expect(request.confirm).toEqual([syncId]);
    // Another device wrote C on top of A while this desktop was away.
    ws.onmessage!(response({
      pushConfirmations: [{ syncId, contentHash: sha256('C') }],
      updatedFiles: [await remoteEntry('C')],
    }));

    await vi.waitFor(async () => expect(await mdContents()).toHaveLength(2));
    expect(await fsp.readFile(filePath, 'utf-8')).toBe('B');
    expect((await mdContents()).sort()).toEqual(['B', 'C']);
    provider.disconnectAll();
  });

  it('confirms a push whose ack was lost from the next sync response, so a later edit applies', async () => {
    const { fsp, provider, remoteEntry, saveBAndDrop, mdContents } = await connected(true);
    const { ws, request } = await saveBAndDrop();
    // The server did store B. It reports the hash it holds for each file the client asks about.
    ws.onmessage!(response({
      pushConfirmations: (request.confirm ?? []).map((id: string) => ({ syncId: id, contentHash: sha256('B') })),
    }));
    await drain();

    ws.onmessage!({ data: JSON.stringify({ type: 'fileContentBroadcast', ...(await remoteEntry('C')), fromConnectionId: 'mobile' }) });
    await vi.waitFor(async () => expect(await fsp.readFile(filePath, 'utf-8')).toBe('C'));
    expect(await mdContents()).toEqual(['C']);
    provider.disconnectAll();
  });
});

/**
 * Layer 1: the manifest must be rebuilt from *current* disk on every (re)connect,
 * not captured once at startup -- otherwise a reconnect re-announces stale state
 * and the server pushes its older copy down (the NIM-853 trigger).
 */
describe('ProjectFileSyncService.buildManifest', () => {
  let tmpDir: string;
  let service: ProjectFileSyncService;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pfs-manifest-'));
    service = new ProjectFileSyncService();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reflects current disk content on rebuild, and does not reseed the baseline', async () => {
    const filePath = path.join(tmpDir, 'doc.md');
    await writeFile(filePath, 'v1', 'utf-8');

    const syncId = syncIdFromPath('doc.md');
    const m1 = await (service as any).buildManifest(tmpDir, 'proj-enc', { seedBaseline: true });
    expect(m1.find((f: any) => f.syncId === syncId)?.contentHash).toBe(sha256('v1'));

    // Local edit lands after the initial sweep.
    await writeFile(filePath, 'v2-much-longer-content', 'utf-8');

    // A reconnect rebuild must carry the NEW hash...
    const m2 = await (service as any).buildManifest(tmpDir, 'proj-enc', { seedBaseline: false });
    expect(m2.find((f: any) => f.syncId === syncId)?.contentHash).toBe(sha256('v2-much-longer-content'));

    // ...but must NOT reseed the baseline (still the last agreed point, v1), so
    // the write-time guard can still tell local has diverged.
    const baseline = (service as any).projectStates.get('proj-enc').get(syncId);
    expect(baseline.contentHash).toBe(sha256('v1'));
  });

  it('includes files under nimbalyst-local/ -- personal sync mirrors local working docs', async () => {
    const fsp = await import('fs/promises');
    const rel = path.join('nimbalyst-local', 'plans', 'x.md');
    const filePath = path.join(tmpDir, rel);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '# plan\n', 'utf-8');

    const manifest = await (service as any).buildManifest(tmpDir, 'proj-enc', { seedBaseline: true });
    const syncId = syncIdFromPath(rel);
    expect(manifest.some((f: any) => f.syncId === syncId)).toBe(true);
  });

  it('leaves out a file whose encrypted form exceeds the server row cap, warning once (NIM-7337)', async () => {
    // 1.6 MB of plaintext is ~2.1 MB once encrypted and base64'd: over the 2 MB DO SQLite cap.
    await writeFile(path.join(tmpDir, 'huge.md'), 'x'.repeat(1_600_000), 'utf-8');
    await writeFile(path.join(tmpDir, 'ok.md'), 'x'.repeat(1_000_000), 'utf-8');
    const warn = vi.spyOn(logger.main, 'warn');

    const m1 = await (service as any).buildManifest(tmpDir, 'proj-enc', { seedBaseline: true });
    const m2 = await (service as any).buildManifest(tmpDir, 'proj-enc', { seedBaseline: false });

    for (const manifest of [m1, m2]) {
      expect(manifest.map((f: any) => f.syncId)).toEqual([syncIdFromPath('ok.md')]);
    }
    expect((service as any).projectStates.get('proj-enc').has(syncIdFromPath('huge.md'))).toBe(false);
    expect(warn.mock.calls.filter(([msg]) => String(msg).includes('huge.md'))).toHaveLength(1);
    warn.mockRestore();
  });
});

/**
 * Layer 3: the baseline is persisted durably, so after a restart the write-time
 * guard can still tell that a file diverged locally even when the remote copy
 * carries a newer mtime (the case Guard 1 alone cannot catch).
 */
describe('ProjectFileSyncService durable baseline', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pfs-durable-'));
    dbBaselineStore.clear();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('persists the baseline and refuses an overwrite of a locally-diverged file after restart', async () => {
    const fsp = await import('fs/promises');
    const rel = path.join('planning', 'durable.md');
    const filePath = path.join(tmpDir, rel);
    const syncId = syncIdFromPath(rel);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });

    // First instance seeds + persists the baseline from disk (initial sweep).
    const baselineContent = '# Base\n' + 'a'.repeat(50);
    const baselineMtime = Date.now() - 120_000;
    await writeFile(filePath, baselineContent, 'utf-8');
    await fsp.utimes(filePath, new Date(baselineMtime), new Date(baselineMtime));

    const first = new ProjectFileSyncService();
    await (first as any).buildManifest(tmpDir, 'proj-enc', { seedBaseline: true });
    expect(dbBaselineStore.has(`proj-enc|${syncId}`)).toBe(true);

    // Local edit lands (content diverges from baseline) with a mtime that is
    // NEWER than baseline but OLDER than the incoming remote -- so the mtime
    // guard alone would let the remote win; only the baseline saves it.
    const localContent = '# Local edit\n' + 'b'.repeat(4000);
    const localMtime = Date.now() - 60_000;
    await writeFile(filePath, localContent, 'utf-8');
    await fsp.utimes(filePath, new Date(localMtime), new Date(localMtime));

    // Restart: a brand-new instance with an empty in-memory cache.
    const second = new ProjectFileSyncService();
    (second as any).provider = {
      pushFileContent: vi.fn(ackContent),
      pushFileBatch: vi.fn(ackBatch),
    };
    (second as any)._fileMapCache = new Map();
    (second as any)._fileMapCache.set('proj-enc', { fileMap: new Map([[syncId, filePath]]), workspacePath: tmpDir });
    await (second as any).loadBaseline('proj-enc');

    // Server replays a different copy with the NEWEST mtime.
    const serverContent = '# Server\n' + 'c'.repeat(2000);
    const response = {
      updatedFiles: [{
        syncId,
        relativePath: rel,
        title: 'durable',
        content: serverContent,
        contentHash: sha256(serverContent),
        lastModifiedAt: Date.now(),
        hasYjs: false,
      }],
      newFiles: [],
      deletedSyncIds: [],
      needFromClient: [],
      yjsUpdates: [],
    };
    await (second as any).handleSyncResponse('proj-enc', response);

    // The locally-diverged content must survive; the durable baseline is what
    // makes Guard 2 fire after the restart.
    const after = await fsp.readFile(filePath, 'utf-8');
    expect(after).toBe(localContent);
  });
});

/**
 * Layer 4: a remote write must not clobber an editor's unsaved buffer. While the
 * path is dirty the write is deferred, and it applies once the editor is clean.
 */
describe('ProjectFileSyncService dirty-editor deferral', () => {
  let tmpDir: string;
  let service: ProjectFileSyncService;

  beforeEach(async () => {
    dirtyEditorRegistry.clear();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pfs-dirty-'));
    service = new ProjectFileSyncService();
    (service as any).provider = {
      pushFileContent: vi.fn(ackContent),
      pushFileBatch: vi.fn(ackBatch),
      disconnectAll: vi.fn(),
    };
    (service as any)._fileMapCache = new Map();
    (service as any)._fileMapCache.set('proj-enc', { fileMap: new Map(), workspacePath: tmpDir });
    (service as any).projectStates.set('proj-enc', new Map());
  });

  afterEach(async () => {
    service.shutdown();
    dirtyEditorRegistry.clear();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('defers a remote write while the editor is dirty, then applies it once clean', async () => {
    const fsp = await import('fs/promises');
    const rel = 'doc.md';
    const filePath = path.join(tmpDir, rel);
    const syncId = syncIdFromPath(rel);

    // A clean, in-sync file: local == baseline, so a genuinely newer remote would
    // normally fast-forward straight to disk.
    const diskContent = '# Disk\n' + 'a'.repeat(20);
    const diskMtime = Date.now() - 60_000;
    await writeFile(filePath, diskContent, 'utf-8');
    await fsp.utimes(filePath, new Date(diskMtime), new Date(diskMtime));
    (service as any).projectStates.get('proj-enc').set(syncId, {
      syncId, contentHash: sha256(diskContent), lastSyncedMtime: diskMtime,
    });
    (service as any)._fileMapCache.get('proj-enc').fileMap.set(syncId, filePath);

    // Editor has unsaved edits for this path.
    dirtyEditorRegistry.setDirty(filePath, true);

    // A legitimately newer remote update arrives.
    const remoteContent = '# Remote\n' + 'b'.repeat(2000);
    const response = {
      updatedFiles: [{
        syncId, relativePath: rel, title: 'doc',
        content: remoteContent, contentHash: sha256(remoteContent),
        lastModifiedAt: Date.now(), hasYjs: false,
      }],
      newFiles: [], deletedSyncIds: [], needFromClient: [], yjsUpdates: [],
    };
    await (service as any).handleSyncResponse('proj-enc', response);

    // Deferred: disk untouched while the editor is dirty.
    expect(await fsp.readFile(filePath, 'utf-8')).toBe(diskContent);

    // Editor saves/closes -> clean -> deferred write flushes and applies. The
    // flush is fire-and-forget I/O, so poll until it lands.
    dirtyEditorRegistry.setDirty(filePath, false);
    const start = Date.now();
    let settled = diskContent;
    while (Date.now() - start < 1000) {
      settled = await fsp.readFile(filePath, 'utf-8');
      if (settled === remoteContent) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(settled).toBe(remoteContent);
  });
});

/**
 * Review follow-ups (NIM-853): three edge cases in handleSyncResponse.
 */
describe('ProjectFileSyncService sync-response edge cases', () => {
  let tmpDir: string;
  let service: ProjectFileSyncService;
  let pushFileBatch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dirtyEditorRegistry.clear();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pfs-edge-'));
    service = new ProjectFileSyncService();
    pushFileBatch = vi.fn(ackBatch);
    (service as any).provider = {
      pushFileContent: vi.fn(ackContent),
      pushFileBatch,
      disconnectAll: vi.fn(),
    };
    (service as any)._fileMapCache = new Map();
    (service as any)._fileMapCache.set('proj-enc', { fileMap: new Map(), workspacePath: tmpDir });
    (service as any).projectStates.set('proj-enc', new Map());
  });

  afterEach(async () => {
    service.shutdown();
    dirtyEditorRegistry.clear();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('advances the baseline after a needFromClient push so later remote edits are accepted', async () => {
    const fsp = await import('fs/promises');
    const rel = 'doc.md';
    const filePath = path.join(tmpDir, rel);
    const syncId = syncIdFromPath(rel);

    // Local file diverged from an old baseline (the server will request it).
    const localContent = '# Local newer\n' + 'x'.repeat(100);
    const localMtime = Date.now() - 30_000;
    await writeFile(filePath, localContent, 'utf-8');
    await fsp.utimes(filePath, new Date(localMtime), new Date(localMtime));
    (service as any).projectStates.get('proj-enc').set(syncId, {
      syncId, contentHash: sha256('# Old baseline\n'), lastSyncedMtime: Date.now() - 90_000,
    });
    (service as any)._fileMapCache.get('proj-enc').fileMap.set(syncId, filePath);

    // Server asks for our copy.
    await (service as any).handleSyncResponse('proj-enc', {
      updatedFiles: [], newFiles: [], deletedSyncIds: [], needFromClient: [syncId], yjsUpdates: [],
    });
    expect(pushFileBatch).toHaveBeenCalledTimes(1);

    // Baseline must now equal what we pushed (current local content).
    const baseline = (service as any).projectStates.get('proj-enc').get(syncId);
    expect(baseline.contentHash).toBe(sha256(localContent));

    // A genuinely newer remote edit must now fast-forward, not be rejected.
    const remoteContent = '# Mobile edit\n' + 'y'.repeat(200);
    await (service as any).handleSyncResponse('proj-enc', {
      updatedFiles: [{
        syncId, relativePath: rel, title: 'doc',
        content: remoteContent, contentHash: sha256(remoteContent),
        lastModifiedAt: Date.now(), hasYjs: false,
      }],
      newFiles: [], deletedSyncIds: [], needFromClient: [], yjsUpdates: [],
    });
    expect(await fsp.readFile(filePath, 'utf-8')).toBe(remoteContent);
  });

  it('advances baselines only for files the server confirmed stored (NIM-7337)', async () => {
    const files = ['stored.md', 'rejected.md'].map((rel) => ({ rel, filePath: path.join(tmpDir, rel), syncId: syncIdFromPath(rel) }));
    for (const f of files) {
      await writeFile(f.filePath, `# ${f.rel} local\n`, 'utf-8');
      (service as any).projectStates.get('proj-enc').set(f.syncId, { syncId: f.syncId, contentHash: sha256('old'), lastSyncedMtime: 1 });
      (service as any)._fileMapCache.get('proj-enc').fileMap.set(f.syncId, f.filePath);
    }
    pushFileBatch.mockResolvedValueOnce({
      stored: [files[0].syncId],
      rejected: [{ syncId: files[1].syncId, code: 'store_failed', message: 'boom' }],
      unconfirmed: [],
    });

    await (service as any).handleSyncResponse('proj-enc', {
      updatedFiles: [], newFiles: [], deletedSyncIds: [], needFromClient: files.map((f) => f.syncId), yjsUpdates: [],
    });

    const state = (service as any).projectStates.get('proj-enc');
    expect(state.get(files[0].syncId).contentHash).toBe(sha256('# stored.md local\n'));
    expect(state.get(files[1].syncId).contentHash).toBe(sha256('old'));
  });

  it('does not delete a file that is open with unsaved edits', async () => {
    const fsp = await import('fs/promises');
    const rel = 'keep.md';
    const filePath = path.join(tmpDir, rel);
    const syncId = syncIdFromPath(rel);
    await writeFile(filePath, '# Keep me\n', 'utf-8');
    (service as any)._fileMapCache.get('proj-enc').fileMap.set(syncId, filePath);

    dirtyEditorRegistry.setDirty(filePath, true);
    await (service as any).handleSyncResponse('proj-enc', {
      updatedFiles: [], newFiles: [], deletedSyncIds: [syncId], needFromClient: [], yjsUpdates: [],
    });

    // File survives the remote delete because the editor has unsaved changes.
    expect(await fsp.readFile(filePath, 'utf-8')).toBe('# Keep me\n');
  });

  it('does not delete files in a bulk deletedSyncIds burst with no editor open', async () => {
    const fsp = await import('fs/promises');
    // The real regression: a workspace is scanned wholesale for .md files, so
    // ordinary repo source files (extension docs, command definitions) end up
    // in the room. One stale tombstone per path then unlinked all of them from
    // the git working tree on every sync -- no editor involved, so the
    // dirty-editor guard above never applied.
    const rels = ['docs/a.md', 'docs/b.md', 'docs/c.md'];
    const syncIds: string[] = [];
    await fsp.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
    for (const rel of rels) {
      const filePath = path.join(tmpDir, rel);
      const syncId = syncIdFromPath(rel);
      syncIds.push(syncId);
      await writeFile(filePath, `# ${rel}\n`, 'utf-8');
      (service as any)._fileMapCache.get('proj-enc').fileMap.set(syncId, filePath);
    }

    await (service as any).handleSyncResponse('proj-enc', {
      updatedFiles: [], newFiles: [], deletedSyncIds: syncIds, needFromClient: [], yjsUpdates: [],
    });

    for (const rel of rels) {
      expect(await fsp.readFile(path.join(tmpDir, rel), 'utf-8')).toBe(`# ${rel}\n`);
    }
  });

  it('registers a remote-created file in the file map for later delete resolution', async () => {
    const fsp = await import('fs/promises');
    const rel = 'from-mobile.md';
    const filePath = path.join(tmpDir, rel);
    const syncId = syncIdFromPath(rel);
    const content = '# Created on mobile\n';

    await (service as any).handleSyncResponse('proj-enc', {
      updatedFiles: [], deletedSyncIds: [], needFromClient: [], yjsUpdates: [],
      newFiles: [{
        syncId, relativePath: rel, title: 'from-mobile',
        content, contentHash: sha256(content), lastModifiedAt: Date.now(), hasYjs: false,
      }],
    });

    // Written to disk AND registered, so a later remote delete can resolve it.
    expect(await fsp.readFile(filePath, 'utf-8')).toBe(content);
    const cache = (service as any)._fileMapCache.get('proj-enc');
    expect(cache.fileMap.get(syncId)).toBe(filePath);
  });
});

/**
 * Review follow-up: a remote delete deferred while the editor is dirty must be
 * resolved when the editor becomes clean -- applied if the on-disk file is
 * unchanged, or overridden (resurrected) if a saved local edit diverged it.
 */
describe('ProjectFileSyncService deferred remote delete', () => {
  let tmpDir: string;
  let service: ProjectFileSyncService;
  let pushFileContent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dirtyEditorRegistry.clear();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pfs-del-'));
    service = new ProjectFileSyncService();
    pushFileContent = vi.fn(ackContent);
    (service as any).provider = { pushFileContent, pushFileBatch: vi.fn(ackBatch), disconnectAll: vi.fn() };
    (service as any)._fileMapCache = new Map();
    (service as any)._fileMapCache.set('proj-enc', { fileMap: new Map(), workspacePath: tmpDir });
    (service as any).projectStates.set('proj-enc', new Map());
  });

  afterEach(async () => {
    service.shutdown();
    dirtyEditorRegistry.clear();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Seed an on-disk file + baseline + file-map entry, then defer a delete for it. */
  async function deferDeleteFor(rel: string, content: string) {
    const filePath = path.join(tmpDir, rel);
    const syncId = syncIdFromPath(rel);
    await writeFile(filePath, content, 'utf-8');
    (service as any).projectStates.get('proj-enc').set(syncId, {
      syncId, contentHash: sha256(content), lastSyncedMtime: Date.now() - 60_000,
    });
    (service as any)._fileMapCache.get('proj-enc').fileMap.set(syncId, filePath);
    dirtyEditorRegistry.setDirty(filePath, true);
    await (service as any).handleSyncResponse('proj-enc', {
      updatedFiles: [], newFiles: [], deletedSyncIds: [syncId], needFromClient: [], yjsUpdates: [],
    });
    return { filePath, syncId };
  }

  it('never removes the local file, even once the editor is clean and it matches the baseline', async () => {
    const fsp = await import('fs/promises');
    const { filePath } = await deferDeleteFor('drop.md', '# Drop me\n');

    // Still present while dirty.
    expect(await fsp.readFile(filePath, 'utf-8')).toBe('# Drop me\n');

    // Editor goes clean and the file is byte-identical to the last sync, so
    // this is the case that used to `fs.unlink` it. A workspace is a real
    // directory (often a git working tree) and a tombstone in the room state
    // is not consent to destroy the user's copy: a single stale tombstone
    // deleted the same paths on every client on every sync, indefinitely.
    dirtyEditorRegistry.setDirty(filePath, false);
    const start = Date.now();
    while (Date.now() - start < 300) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await fsp.readFile(filePath, 'utf-8')).toBe('# Drop me\n');
  });

  it('a saved local edit overrides the deferred delete (resurrect via re-push)', async () => {
    const fsp = await import('fs/promises');
    const { filePath } = await deferDeleteFor('survive.md', '# Original\n');

    // Simulate the user saving a real edit before the tab goes clean: disk now
    // diverges from the baseline.
    const edited = '# Saved edit\n' + 'z'.repeat(200);
    await writeFile(filePath, edited, 'utf-8');

    dirtyEditorRegistry.setDirty(filePath, false);
    const start = Date.now();
    while (Date.now() - start < 1000) {
      if (pushFileContent.mock.calls.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // File preserved and re-pushed (resurrected on the server), not deleted.
    expect(await fsp.readFile(filePath, 'utf-8')).toBe(edited);
    expect(pushFileContent).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectFileSyncService local delete', () => {
  let tmpDir: string;
  let service: ProjectFileSyncService;
  let deleteFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dbBaselineStore.clear();
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'pfs-localdel-'));
    service = new ProjectFileSyncService();
    deleteFile = vi.fn();
    (service as any).provider = { deleteFile, isConnected: vi.fn(() => true), disconnectAll: vi.fn() };
    (service as any)._fileMapCache = new Map();
    (service as any)._fileMapCache.set('proj-enc', { fileMap: new Map(), workspacePath: tmpDir });
    (service as any).projectStates.set('proj-enc', new Map());
  });

  afterEach(async () => {
    service.shutdown();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('pushes the deletion with the path-derived syncId and clears baseline + file map', async () => {
    const rel = path.join('design', 'gone.md');
    const filePath = path.join(tmpDir, rel);
    const syncId = syncIdFromPath(rel);

    (service as any).projectStates.get('proj-enc').set(syncId, {
      syncId, contentHash: 'abc', lastSyncedMtime: 123,
    });
    (service as any)._fileMapCache.get('proj-enc').fileMap.set(syncId, filePath);
    dbBaselineStore.set(`proj-enc|${syncId}`, {
      project_id: 'proj-enc', sync_id: syncId, content_hash: 'abc', last_synced_mtime: 123,
    });

    service.handleFileDeletedByPath(filePath, tmpDir, 'proj-enc');
    // deleteBaseline persists asynchronously
    await new Promise((r) => setTimeout(r, 20));

    expect(deleteFile).toHaveBeenCalledWith('proj-enc', syncId);
    expect((service as any).projectStates.get('proj-enc').has(syncId)).toBe(false);
    expect((service as any)._fileMapCache.get('proj-enc').fileMap.has(syncId)).toBe(false);
    expect(dbBaselineStore.has(`proj-enc|${syncId}`)).toBe(false);
  });

  it('reports per-project stats for the settings UI', () => {
    const syncId = syncIdFromPath('a.md');
    (service as any).projectStates.get('proj-enc').set(syncId, {
      syncId, contentHash: 'abc', lastSyncedMtime: 123,
    });

    expect(service.getProjectStats('proj-enc')).toEqual({ connected: true, fileCount: 1 });
    expect(service.getProjectStats('unknown')).toEqual({ connected: true, fileCount: 0 });
  });
});
