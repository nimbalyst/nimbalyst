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

    pushFileContent = vi.fn(async () => undefined);
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

    pushFileBatch = vi.fn(async () => undefined);
    (service as any).provider = {
      pushFileContent: vi.fn(async () => undefined),
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
      pushFileContent: vi.fn(async () => undefined),
      pushFileBatch: vi.fn(async () => undefined),
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
      pushFileContent: vi.fn(async () => undefined),
      pushFileBatch: vi.fn(async () => undefined),
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
    pushFileBatch = vi.fn(async () => undefined);
    (service as any).provider = {
      pushFileContent: vi.fn(async () => undefined),
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
    pushFileContent = vi.fn(async () => undefined);
    (service as any).provider = { pushFileContent, pushFileBatch: vi.fn(async () => undefined), disconnectAll: vi.fn() };
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

  it('applies the deferred delete once the editor is clean and the file is unchanged', async () => {
    const fsp = await import('fs/promises');
    const { filePath } = await deferDeleteFor('drop.md', '# Drop me\n');

    // Still present while dirty.
    expect(await fsp.readFile(filePath, 'utf-8')).toBe('# Drop me\n');

    // Editor closes/discards -> clean -> deferred delete applies.
    dirtyEditorRegistry.setDirty(filePath, false);
    const start = Date.now();
    let gone = false;
    while (Date.now() - start < 1000) {
      try { await fsp.readFile(filePath, 'utf-8'); } catch { gone = true; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(gone).toBe(true);
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
