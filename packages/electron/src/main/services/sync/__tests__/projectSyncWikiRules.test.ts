// @vitest-environment node
/**
 * Project file sync inside a Local wiki folder. File identity on the wire is
 * the path, so a page rename on desktop A reaches desktop B as delete(old) +
 * add(new). Desktops never delete on a remote delete, so before these rules B
 * kept the old file, pushed it back, and the wiki library then saw two files
 * with one id and rewrote one of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';

vi.mock('../../SyncManager', () => ({ getPersonalDocSyncConfig: () => null }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn(async () => ({ rows: [] })) } }));

import { ProjectFileSyncService } from '../../ProjectFileSyncService';
import { dirtyEditorRegistry } from '../../DirtyEditorRegistry';
import { acquireWriteLock, openWiki } from '@nimbalyst/local-wiki';

const WIKI = 'nimbalyst-local/wiki';
const ID = '01J9Z3K6V4C2W8N5QX7R1T0BHM';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const syncIdOf = (rel: string) => sha256(rel);
const page = (id: string, body = '# Zebra\n\nNotes.\n') => `---\nid: ${id}\n---\n${body}`;
const ack = async (_p: string, syncId: string) => ({ stored: [syncId], rejected: [], unconfirmed: [] });
const ackBatch = async (_p: string, files: Array<{ syncId: string }>) => ({ stored: files.map((f) => f.syncId), rejected: [], unconfirmed: [] });

describe('project file sync inside a Local wiki', () => {
  let ws: string;
  let wiki: string;
  let service: ProjectFileSyncService;
  let pushFileContent: ReturnType<typeof vi.fn>;
  let pushFileBatch: ReturnType<typeof vi.fn>;
  let deleteFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dirtyEditorRegistry.clear();
    ws = await mkdtemp(path.join(os.tmpdir(), 'pfs-wiki-'));
    wiki = path.join(ws, ...WIKI.split('/'));
    await mkdir(wiki, { recursive: true });
    await writeFile(path.join(wiki, '.nimbalyst-wiki.yaml'), 'formatVersion: 1\n');
    service = new ProjectFileSyncService();
    pushFileContent = vi.fn(ack);
    pushFileBatch = vi.fn(ackBatch);
    deleteFile = vi.fn();
    (service as any).provider = { pushFileContent, pushFileBatch, deleteFile, disconnectAll: vi.fn(), resync: vi.fn() };
    (service as any)._fileMapCache = new Map([['proj', { fileMap: new Map(), workspacePath: ws }]]);
    (service as any).projectStates.set('proj', new Map());
  });

  afterEach(async () => {
    service.shutdown();
    await rm(ws, { recursive: true, force: true });
  });

  /** A file this desktop already synced: on disk, with a baseline and a file-map entry. */
  async function seedSynced(rel: string, content: string) {
    const abs = path.join(ws, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
    const syncId = syncIdOf(rel);
    const mtime = Math.floor((await stat(abs)).mtimeMs);
    (service as any).projectStates.get('proj').set(syncId, { syncId, contentHash: sha256(content), lastSyncedMtime: mtime });
    (service as any)._fileMapCache.get('proj').fileMap.set(syncId, abs);
    return { abs, syncId };
  }

  const remoteFile = (rel: string, content: string) => ({
    syncId: syncIdOf(rel), relativePath: rel, title: path.posix.basename(rel, '.md'),
    content, contentHash: sha256(content), lastModifiedAt: Date.now() + 1000, hasYjs: false,
  });

  const trashEntries = async () => {
    try {
      return await readdir(path.join(wiki, '.trash'));
    } catch {
      return [];
    }
  };

  /** B ends with one live page carrying the id, the old copy in trash, and nothing pushed back. */
  async function expectMovedCleanly() {
    expect((await readdir(wiki)).filter((n) => n.endsWith('.md'))).toEqual(['Apple.md']);
    expect(await readFile(path.join(wiki, 'Apple.md'), 'utf-8')).toBe(page(ID));
    const entries = await trashEntries();
    expect(entries).toHaveLength(1);
    const entryDir = path.join(wiki, '.trash', entries[0]);
    expect(await readFile(path.join(entryDir, 'Zebra.md'), 'utf-8')).toBe(page(ID));
    expect(JSON.parse(await readFile(path.join(entryDir, '.trash.json'), 'utf-8'))).toMatchObject({
      formatVersion: 1, kind: 'page', id: ID, originalDir: '', entries: { md: 'Zebra.md' },
    });
    expect(pushFileContent).not.toHaveBeenCalled();
    expect(pushFileBatch).not.toHaveBeenCalled();
    expect((service as any)._fileMapCache.get('proj').fileMap.has(syncIdOf(`${WIKI}/Zebra.md`))).toBe(false);

    const lib = await openWiki(wiki, { repair: false });
    const snapshot = await lib.snapshot();
    expect(snapshot.pages.filter((p) => p.trashedAt === null).map((p) => [p.id, p.path])).toEqual([[ID, 'Apple.md']]);
    expect(snapshot.issues.filter((i) => i.code === 'duplicate-id')).toEqual([]);
  }

  it('applies a rename that arrives as delete then add (realtime) as a move', async () => {
    const old = await seedSynced(`${WIKI}/Zebra.md`, page(ID));

    await (service as any).handleRemoteFileDelete('proj', old.syncId);
    await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/Apple.md`, page(ID)));

    await expectMovedCleanly();
  });

  it('applies a rename that arrives in one sync response, without pushing the old path back', async () => {
    const old = await seedSynced(`${WIKI}/Zebra.md`, page(ID));

    // The server tombstoned the old path, and asks for it because B's manifest still lists it.
    await (service as any).handleSyncResponse('proj', {
      updatedFiles: [], newFiles: [remoteFile(`${WIKI}/Apple.md`, page(ID))],
      deletedSyncIds: [old.syncId], needFromClient: [old.syncId], yjsUpdates: [],
    });

    await expectMovedCleanly();
  });

  it('keeps the file when no other wiki file carries its id, or the check cannot be verified', async () => {
    const other = '01J9Z3K6V4C2W8N5QX7R1T0BHN';
    const lone = await seedSynced(`${WIKI}/Lone.md`, page('01J9Z3K6V4C2W8N5QX7R1T0BHP'));
    // Same id, but the other copy's frontmatter does not parse: not proof of a move.
    const edited = await seedSynced(`${WIKI}/Zebra.md`, page(ID));
    await writeFile(path.join(wiki, 'Apple.md'), `---\nid: ${ID}\ntitle: [unclosed\n---\n`, 'utf-8');
    // Same id at another path, but the old copy has unsynced local edits.
    const diverged = await seedSynced(`${WIKI}/Diverged.md`, page(other, '# old\n'));
    await writeFile(diverged.abs, page(other, '# local edit\n'), 'utf-8');
    await writeFile(path.join(wiki, 'Moved.md'), page(other, '# old\n'), 'utf-8');

    for (const f of [lone, edited, diverged]) await (service as any).handleRemoteFileDelete('proj', f.syncId);

    expect(await readFile(lone.abs, 'utf-8')).toBe(page('01J9Z3K6V4C2W8N5QX7R1T0BHP'));
    expect(await readFile(edited.abs, 'utf-8')).toBe(page(ID));
    expect(await readFile(diverged.abs, 'utf-8')).toBe(page(other, '# local edit\n'));
    expect(await trashEntries()).toEqual([]);
  });

  it('never syncs the wiki trash folder', async () => {
    const { isProjectSyncPath } = await import('../projectSyncWikiRules');
    const trashed = path.join(wiki, '.trash', `1760000000000-${ID}`, 'Zebra.md');
    await mkdir(path.dirname(trashed), { recursive: true });
    await writeFile(trashed, page(ID), 'utf-8');
    await writeFile(path.join(wiki, 'Apple.md'), page(ID), 'utf-8');

    expect(isProjectSyncPath(trashed, ws)).toBe(false);
    expect(isProjectSyncPath(path.join(wiki, 'Apple.md'), ws)).toBe(true);
    expect(isProjectSyncPath(path.join(ws, 'notes', '.trash', 'x.md'), ws)).toBe(true);

    await service.handleFileSaved(trashed, ws, 'proj');
    expect(pushFileContent).not.toHaveBeenCalled();
    const manifest = await (service as any).buildManifest(ws, 'proj', { seedBaseline: true });
    expect(manifest.map((f: any) => f.syncId).sort()).toEqual(
      [syncIdOf(`${WIKI}/Apple.md`), syncIdOf(`${WIKI}/.nimbalyst-wiki.yaml`)].sort(),
    );
    // An older client may already have put trash files in the room.
    await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/.trash/1-${ID}/Old.md`, page(ID)));
    expect(await readdir(path.join(wiki, '.trash'))).toEqual([`1760000000000-${ID}`]);
  });

  it('carries wiki tables and the marker only inside the wiki folder', async () => {
    const { isProjectSyncPath } = await import('../projectSyncWikiRules');
    await mkdir(path.join(ws, 'data'), { recursive: true });
    await writeFile(path.join(wiki, 'Partners.csv'), 'id,title\n1,Acme\n', 'utf-8');
    await writeFile(path.join(ws, 'data', 'Export.csv'), 'a,b\n', 'utf-8');
    await writeFile(path.join(ws, 'data', '.nimbalyst-wiki.yaml'), 'formatVersion: 1\n', 'utf-8');
    await writeFile(path.join(wiki, 'diagram.excalidraw'), '{}', 'utf-8');
    await mkdir(path.join(wiki, '.trash', `1-${ID}`), { recursive: true });

    expect(isProjectSyncPath(path.join(wiki, 'Partners.csv'), ws)).toBe(true);
    expect(isProjectSyncPath(path.join(wiki, '.trash', `1-${ID}`, 'Partners.csv'), ws)).toBe(false);
    expect(isProjectSyncPath(path.join(ws, 'notes', 'Plan.md'), ws)).toBe(true);

    const manifest = await (service as any).buildManifest(ws, 'proj', { seedBaseline: true });
    expect(manifest.map((f: any) => f.syncId).sort()).toEqual(
      [syncIdOf(`${WIKI}/.nimbalyst-wiki.yaml`), syncIdOf(`${WIKI}/Partners.csv`)].sort(),
    );

    await service.handleFileSaved(path.join(wiki, 'Partners.csv'), ws, 'proj');
    expect(pushFileContent).toHaveBeenCalledWith('proj', syncIdOf(`${WIKI}/Partners.csv`), 'id,title\n1,Acme\n', `${WIKI}/Partners.csv`, 'Partners', expect.any(Number));
    await service.handleFileSaved(path.join(ws, 'data', 'Export.csv'), ws, 'proj');
    expect(pushFileContent).toHaveBeenCalledTimes(1);

    // A table from another desktop lands in the wiki; a stray CSV outside it is not written.
    await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/Clients.csv`, 'id\n2\n'));
    await (service as any).handleRemoteFileUpdate('proj', remoteFile('elsewhere/Stray.csv', 'id\n3\n'));
    expect(await readFile(path.join(wiki, 'Clients.csv'), 'utf-8')).toBe('id\n2\n');
    await expect(stat(path.join(ws, 'elsewhere', 'Stray.csv'))).rejects.toThrow();
  });

  it('syncs tables only once the wiki exists, but always accepts its marker so a second desktop can bootstrap', async () => {
    const { isProjectSyncPath } = await import('../projectSyncWikiRules');
    const marker = path.join(wiki, '.nimbalyst-wiki.yaml');
    await rm(marker);
    await writeFile(path.join(wiki, 'Partners.csv'), 'id\n1\n', 'utf-8');

    // No marker: the folder is only the configured location, not a wiki.
    expect(isProjectSyncPath(path.join(wiki, 'Partners.csv'), ws)).toBe(false);
    expect(isProjectSyncPath(marker, ws)).toBe(true);
    expect(isProjectSyncPath(path.join(wiki, 'Sub', '.nimbalyst-wiki.yaml'), ws)).toBe(false);
    const manifest = await (service as any).buildManifest(ws, 'proj', { seedBaseline: true });
    expect(manifest).toEqual([]);
    await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/Clients.csv`, 'id\n2\n'));
    await expect(stat(path.join(wiki, 'Clients.csv'))).rejects.toThrow();

    // The marker arrives later: nothing is replayed from memory; the server is
    // asked again and the table returns through the normal receive path.
    const resync = vi.fn();
    (service as any).provider.resync = resync;
    await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/.nimbalyst-wiki.yaml`, 'formatVersion: 1\n'));
    expect(resync).toHaveBeenCalledWith('proj');
    await expect(stat(path.join(wiki, 'Clients.csv'))).rejects.toThrow();
    await (service as any).handleSyncResponse('proj', {
      updatedFiles: [], newFiles: [remoteFile(`${WIKI}/Clients.csv`, 'id\n2\n')], deletedSyncIds: [], needFromClient: [], yjsUpdates: [],
    });
    expect(await readFile(path.join(wiki, 'Clients.csv'), 'utf-8')).toBe('id\n2\n');
    expect(isProjectSyncPath(path.join(wiki, 'Partners.csv'), ws)).toBe(true);
  });

  it('does not resurrect a table deleted before the marker arrived', async () => {
    await rm(path.join(wiki, '.nimbalyst-wiki.yaml'));
    (service as any).provider.resync = vi.fn();
    await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/Gone.csv`, 'id\n1\n'));
    await (service as any).handleRemoteFileDelete('proj', syncIdOf(`${WIKI}/Gone.csv`));
    await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/.nimbalyst-wiki.yaml`, 'formatVersion: 1\n'));
    await expect(stat(path.join(wiki, 'Gone.csv'))).rejects.toThrow();
  });

  it('writes a table that precedes the marker in one unordered batch on a desktop without the wiki', async () => {
    await rm(path.join(wiki, '.nimbalyst-wiki.yaml'));
    await (service as any).handleSyncResponse('proj', {
      updatedFiles: [], deletedSyncIds: [], needFromClient: [], yjsUpdates: [],
      newFiles: [remoteFile(`${WIKI}/Rows.csv`, 'id\n1\n'), remoteFile(`${WIKI}/.nimbalyst-wiki.yaml`, 'formatVersion: 1\n')],
    });
    expect(await readFile(path.join(wiki, 'Rows.csv'), 'utf-8')).toBe('id\n1\n');
  });

  it('reports every sweep, startup and reconnect, so watcher coverage follows each', async () => {
    await writeFile(path.join(wiki, 'Partners.csv'), 'id\n1\n', 'utf-8');
    const swept = vi.fn();
    const off = service.onSwept(swept);
    await (service as any).buildManifest(ws, 'proj', { seedBaseline: true });
    await (service as any).buildManifest(ws, 'proj', { seedBaseline: false });
    off();
    expect(swept).toHaveBeenCalledTimes(2);
    expect(swept.mock.calls[1][0]).toBe('proj');
    expect(swept.mock.calls[1][1]).toContain(path.join(wiki, 'Partners.csv'));
  });

  it('registers and offers the tables already on disk when the marker appears', async () => {
    const { createProjectSyncWatch } = await import('../projectSyncWatch');
    const bus = { addGitignoreBypass: vi.fn(), removeGitignoreBypass: vi.fn() };
    const saved = vi.fn();
    const wikiCreated = vi.fn();
    const watch = createProjectSyncWatch(ws, 'sub', bus, { saved, deleted: vi.fn(), isOwnWrite: () => false, wikiCreated });
    const marker = path.join(wiki, '.nimbalyst-wiki.yaml');
    const table = path.join(wiki, 'Sub', 'Partners.csv');
    await rm(marker);
    await mkdir(path.dirname(table), { recursive: true });
    await writeFile(table, 'id\n1\n', 'utf-8');
    watch.listener.onAdd(table);
    expect(saved).not.toHaveBeenCalled();

    await writeFile(marker, 'formatVersion: 1\n', 'utf-8');
    watch.listener.onAdd(marker);
    await watch.settled();
    expect(bus.addGitignoreBypass).toHaveBeenCalledWith(ws, table, 'sub');
    expect(saved).toHaveBeenCalledWith(table, 'add');
    expect(wikiCreated).toHaveBeenCalledTimes(1);
    // A later marker edit does not offer the same table again.
    watch.listener.onChange(marker);
    await watch.settled();
    expect(saved.mock.calls.filter(([f]) => f === table)).toHaveLength(1);
    expect(wikiCreated).toHaveBeenCalledTimes(1);
    watch.dispose();
  });

  it('registers nothing from a marker-triggered scan that finishes after disposal', async () => {
    const { createProjectSyncWatch } = await import('../projectSyncWatch');
    const bus = { addGitignoreBypass: vi.fn(), removeGitignoreBypass: vi.fn() };
    const saved = vi.fn();
    const watch = createProjectSyncWatch(ws, 'sub', bus, { saved, deleted: vi.fn(), isOwnWrite: () => false, wikiCreated: vi.fn() });
    await writeFile(path.join(wiki, 'Partners.csv'), 'id\n1\n', 'utf-8');
    watch.listener.onChange(path.join(wiki, '.nimbalyst-wiki.yaml'));
    watch.dispose(); // before the scan's readdir resolves
    await watch.settled();
    expect(bus.addGitignoreBypass.mock.calls.map((c) => c[1])).not.toContain(path.join(wiki, 'Partners.csv'));
    expect(saved).not.toHaveBeenCalledWith(path.join(wiki, 'Partners.csv'), 'add');
  });

  it('watches gitignored wiki tables: structural events, a bypass for changes, and removal', async () => {
    const { createProjectSyncWatch } = await import('../projectSyncWatch');
    const bus = { addGitignoreBypass: vi.fn(), removeGitignoreBypass: vi.fn() };
    const saved = vi.fn();
    const deleted = vi.fn();
    const own = new Set<string>();
    const watch = createProjectSyncWatch(ws, 'sub', bus, { saved, deleted, isOwnWrite: (f) => own.has(f), wikiCreated: vi.fn() });
    const table = path.join(wiki, 'Partners.csv');
    const existing = path.join(wiki, 'Clients.csv');
    const outside = path.join(ws, 'data', 'Export.csv');
    await writeFile(table, 'id\n1\n', 'utf-8');
    await writeFile(existing, 'id\n2\n', 'utf-8');

    // Without the opt-in the bus never reports a gitignored CSV being created or removed.
    expect(watch.listener.receiveGitignoredStructureEvents).toBe(true);
    watch.listener.onAdd(table);
    expect(bus.addGitignoreBypass).toHaveBeenCalledWith(ws, table, 'sub');
    expect(saved).toHaveBeenCalledWith(table, 'add');
    watch.listener.onChange(table);
    expect(saved).toHaveBeenLastCalledWith(table, 'change');
    // Found by the startup sweep, so no add event: tracking gives it change events.
    watch.track(existing);
    watch.track(path.join(wiki, 'Page.md'));
    expect(bus.addGitignoreBypass.mock.calls.map((c) => c[1])).toEqual([table, existing]);
    // A remote write's echo is still covered for later local edits.
    const remote = path.join(wiki, 'Remote.csv');
    await writeFile(remote, 'id\n', 'utf-8');
    own.add(remote);
    watch.listener.onAdd(remote);
    expect(saved).not.toHaveBeenCalledWith(remote, 'add');
    expect(bus.addGitignoreBypass).toHaveBeenLastCalledWith(ws, remote, 'sub');

    watch.listener.onAdd(outside);
    expect(saved).not.toHaveBeenCalledWith(outside, 'add');

    // Removing the whole wiki: the tracked table's delete still propagates without the marker.
    await rm(path.join(wiki, '.nimbalyst-wiki.yaml'));
    await rm(table);
    watch.listener.onUnlink(table);
    expect(deleted).toHaveBeenCalledWith(table);
    expect(bus.removeGitignoreBypass).toHaveBeenCalledWith(ws, table, 'sub');

    watch.dispose();
    expect(bus.removeGitignoreBypass.mock.calls.map((c) => c[1]).sort()).toEqual([existing, remote, table].sort());
  });

  it('does not trash newer content written at a held page path', async () => {
    const old = await seedSynced(`${WIKI}/Zebra.md`, page(ID));
    await (service as any).handleRemoteFileDelete('proj', old.syncId); // held: no other copy yet
    // The delete was stale: a newer version of the same page lands at the same path.
    await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/Zebra.md`, page(ID, '# Zebra\n\nNewer.\n')));
    await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/Apple.md`, page(ID)));
    expect(await readFile(old.abs, 'utf-8')).toBe(page(ID, '# Zebra\n\nNewer.\n'));
    expect(await trashEntries()).toEqual([]);
  });

  describe('table CSVs, which carry no id of their own', () => {
    const TABLE = 'id,title\n01J9Z3K6V4C2W8N5QX7R1T0BHA,Acme\n';
    const MORE = `${TABLE}01J9Z3K6V4C2W8N5QX7R1T0BHB,Globex\n`;
    const writeType = (typeId: string) => writeFile(path.join(ws, '.nimbalyst', 'trackers', 'partner.yaml'),
      `type: ${JSON.stringify(typeId)}\ndisplayName: Partner\ndisplayNamePlural: Partners\nstorage: table\nfields:\n  - name: title\n    type: string\n`, 'utf-8');
    const put = async (rel: string, text: string) => {
      await mkdir(path.dirname(path.join(wiki, rel)), { recursive: true });
      await writeFile(path.join(wiki, rel), text, 'utf-8');
    };
    const tableEntry = async () => {
      const entries = await trashEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatch(/^\d+-table-partner$/);
      const dir = path.join(wiki, '.trash', entries[0]);
      return { dir, csv: await readFile(path.join(dir, 'Partners.csv'), 'utf-8'), manifest: JSON.parse(await readFile(path.join(dir, '.trash.json'), 'utf-8')) };
    };

    beforeEach(async () => {
      await mkdir(path.join(ws, '.nimbalyst', 'trackers'), { recursive: true });
      await writeType('partner');
    });

    it('trashes the old file, with its activity log, when the moved table holds all its rows', async () => {
      const old = await seedSynced(`${WIKI}/Partners.csv`, TABLE);
      await put('Partners.activity.jsonl', '{"action":"create"}\n');
      await put('Sub/Partners.csv', MORE); // a row was added after the move
      await (service as any).handleRemoteFileDelete('proj', old.syncId);

      await expect(stat(old.abs)).rejects.toThrow();
      await expect(stat(path.join(wiki, 'Partners.activity.jsonl'))).rejects.toThrow();
      const { dir, csv, manifest } = await tableEntry();
      expect(csv).toBe(TABLE);
      expect(await readFile(path.join(dir, 'Partners.activity.jsonl'), 'utf-8')).toBe('{"action":"create"}\n');
      expect(manifest).toMatchObject({
        formatVersion: 1, kind: 'table', id: 'table:partner', typeId: 'partner', originalDir: '',
        entries: { csv: 'Partners.csv', activity: 'Partners.activity.jsonl' },
      });
      expect((service as any)._fileMapCache.get('proj').fileMap.has(old.syncId)).toBe(false);
      expect(pushFileContent).not.toHaveBeenCalled();
    });

    it('keeps the file unless another file of its type holds the same header and every one of its rows', async () => {
      const old = await seedSynced(`${WIKI}/Partners.csv`, TABLE);
      const sheet = await seedSynced(`${WIKI}/Budget.csv`, 'a,b\n1,2\n'); // no table type of that name
      await put('Other/Budget.csv', 'a,b\n1,2\n');
      const attempts = [
        'id,title\n01J9Z3K6V4C2W8N5QX7R1T0BHC,Unrelated\n', // created independently
        'id,name\n01J9Z3K6V4C2W8N5QX7R1T0BHA,Acme\n', // different header
        'id,title\n01J9Z3K6V4C2W8N5QX7R1T0BHA,Acme (older)\n', // the moved copy predates an edit to this one
        '', // empty
        'id,title\n"01J9Z3K6V4C2W8N5QX7R1T0BHA,Acme\n', // unparseable
      ];
      for (const candidate of attempts) {
        await put('Sub/partner.csv', candidate);
        await (service as any).handleRemoteFileDelete('proj', old.syncId);
        expect(await readFile(old.abs, 'utf-8')).toBe(TABLE);
      }
      await (service as any).handleRemoteFileDelete('proj', sheet.syncId);
      expect(await readFile(sheet.abs, 'utf-8')).toBe('a,b\n1,2\n');

      // Unsynced local edits at the old path.
      await put('Sub/partner.csv', MORE);
      await writeFile(old.abs, `${TABLE}01J9Z3K6V4C2W8N5QX7R1T0BHD,Local edit\n`, 'utf-8');
      await (service as any).handleRemoteFileDelete('proj', old.syncId);
      expect(await readFile(old.abs, 'utf-8')).toContain('Local edit');
      expect(await trashEntries()).toEqual([]);
    });

    it('does not hold a delete that arrives before the moved table; a later delivery retires it', async () => {
      const old = await seedSynced(`${WIKI}/Partners.csv`, TABLE);
      await (service as any).handleRemoteFileDelete('proj', old.syncId);
      await (service as any).handleRemoteFileUpdate('proj', remoteFile(`${WIKI}/Sub/Partners.csv`, TABLE));
      expect(await readFile(old.abs, 'utf-8')).toBe(TABLE);
      expect(await trashEntries()).toEqual([]);

      // Reconnect: the server's tombstone for the old path arrives again.
      await (service as any).handleSyncResponse('proj', { updatedFiles: [], newFiles: [], deletedSyncIds: [old.syncId], needFromClient: [], yjsUpdates: [] });
      await expect(stat(old.abs)).rejects.toThrow();
      expect((await tableEntry()).csv).toBe(TABLE);
    });

    it('re-decides under the wiki write lock', async () => {
      const old = await seedSynced(`${WIKI}/Partners.csv`, MORE);
      await put('Sub/Partners.csv', MORE);
      const release = (await acquireWriteLock(wiki, { timeoutMs: 1000, staleMs: 30_000 }))!;
      const pending = (service as any).handleRemoteFileDelete('proj', old.syncId);
      await new Promise((r) => setTimeout(r, 50)); // decided, now waiting for the lock
      await writeFile(path.join(wiki, 'Sub', 'Partners.csv'), TABLE, 'utf-8'); // a row was removed from the live table
      await release();
      await pending;
      expect(await readFile(old.abs, 'utf-8')).toBe(MORE);
      expect(await trashEntries()).toEqual([]);
    });

    it('keeps the file when its editor turns dirty after the check under the lock', async () => {
      const old = await seedSynced(`${WIKI}/Partners.csv`, TABLE);
      await put('Sub/Partners.csv', TABLE);
      // Clean for the service's check, the first decision and the one under the lock; dirty from then on.
      let checks = 0;
      const isDirty = vi.spyOn(dirtyEditorRegistry, 'isDirty').mockImplementation((f) => f === old.abs && ++checks > 3);
      await (service as any).handleRemoteFileDelete('proj', old.syncId);
      isDirty.mockRestore();
      expect(await readFile(old.abs, 'utf-8')).toBe(TABLE);
      expect(await trashEntries()).toEqual([]);
    });

    it('refuses a type id that is not a safe token', async () => {
      await writeType('x/../../../escaped');
      const old = await seedSynced(`${WIKI}/Partners.csv`, TABLE);
      await put('Sub/Partners.csv', TABLE);
      await (service as any).handleRemoteFileDelete('proj', old.syncId);
      expect(await readFile(old.abs, 'utf-8')).toBe(TABLE);
      expect(await readdir(ws)).not.toContain('escaped');
      expect(await trashEntries()).toEqual([]);
    });

    it('does not bring back a table this desktop moved while sync was not running', async () => {
      const old = await seedSynced(`${WIKI}/Partners.csv`, TABLE);
      await rm(old.abs);
      await put('Sub/Partners.csv', TABLE);

      await (service as any).handleSyncResponse('proj', {
        updatedFiles: [], newFiles: [remoteFile(`${WIKI}/Partners.csv`, TABLE)], deletedSyncIds: [], needFromClient: [], yjsUpdates: [],
      });

      await expect(stat(old.abs)).rejects.toThrow();
      expect(deleteFile).toHaveBeenCalledWith('proj', old.syncId);
    });

    it('restores the old path on reconnect when the moved table does not hold its rows', async () => {
      const old = await seedSynced(`${WIKI}/Partners.csv`, TABLE);
      await rm(old.abs);
      await put('Sub/Partners.csv', 'id,title\n01J9Z3K6V4C2W8N5QX7R1T0BHA,Acme (older)\n'); // same id, older cells
      await (service as any).handleSyncResponse('proj', {
        updatedFiles: [], newFiles: [remoteFile(`${WIKI}/Partners.csv`, TABLE)], deletedSyncIds: [], needFromClient: [], yjsUpdates: [],
      });
      expect(await readFile(old.abs, 'utf-8')).toBe(TABLE);
      expect(deleteFile).not.toHaveBeenCalled();
    });
  });

  it('does not bring back a page this desktop moved while sync was not running', async () => {
    // A synced Zebra.md, then `nim` renamed it to Apple.md while the app was closed.
    const old = await seedSynced(`${WIKI}/Zebra.md`, page(ID));
    await rm(old.abs);
    await writeFile(path.join(wiki, 'Apple.md'), page(ID), 'utf-8');

    // The server still has Zebra.md and offers it as new, since absence is not deletion.
    await (service as any).handleSyncResponse('proj', {
      updatedFiles: [], newFiles: [remoteFile(`${WIKI}/Zebra.md`, page(ID))], deletedSyncIds: [], needFromClient: [], yjsUpdates: [],
    });

    expect((await readdir(wiki)).filter((n) => n.endsWith('.md'))).toEqual(['Apple.md']);
    expect(deleteFile).toHaveBeenCalledWith('proj', old.syncId);
  });
});
