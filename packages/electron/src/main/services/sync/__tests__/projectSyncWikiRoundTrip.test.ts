// @vitest-environment node
/**
 * A Local wiki round trip with no device: two desktops' ProjectFileSyncService
 * and a phone share an in-memory relay standing in for ProjectSyncRoom. Desktop
 * A owns the wiki, edits a page and moves its table; the phone edits a page
 * body with the iOS editor bundle's own frontmatter split/join; both desktops
 * reconnect. Both must end with the same files, ids and library tree.
 *
 * The round-tripped wiki is the shared fixture `packages/local-wiki/fixtures/roundtrip/`,
 * so the Swift and Kotlin readers are tested against exactly these files. Run
 * with UPDATE_WIKI_FIXTURES=1 to rewrite it, then regenerate its expected.json
 * with the local-wiki fixtures test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'fs/promises';

vi.mock('../../SyncManager', () => ({ getPersonalDocSyncConfig: () => null }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn(async () => ({ rows: [] })) } }));

import { ProjectFileSyncService } from '../../ProjectFileSyncService';
import { openWiki } from '@nimbalyst/local-wiki';
import { joinFrontmatter, splitFrontmatter } from '../../../../../../ios/src/editor-mobile/frontmatter';

const WIKI = 'nimbalyst-local/wiki';
const FIXTURE = path.resolve(__dirname, '../../../../../../local-wiki/fixtures/roundtrip');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Desktop A's wiki before the trip. Frontmatter is written the way a person would, not the way yaml.dump would. */
const SEED: Record<string, string> = {
  '.nimbalyst-wiki.yaml': 'formatVersion: 1\ntables:\n  partner:\n    order: 3000\n',
  'Home.md': '---\nid: 01JRT0HOME00000000000000AA\norder: 1000\n---\n# Home\n\nStart with [Launch](Projects/Launch.md "id=01JRT0LAUNCH000000000000AA").\n',
  'Projects.md': '---\nid: 01JRT0PROJECTS0000000000AA\ntitle: "Projects"   # quoted on purpose\norder: 2000\n---\n\nAll projects.\n',
  'Projects/Launch.md': '---\nid: 01JRT0LAUNCH000000000000AA\ntags: [launch, q4]\norder: 1000\n---\n# Launch\n\nShip it.\n',
  'Competitors/Acme.md': '---\nid: 01JRT0ACME00000000000000AA\ntype: competitor\ntier: gold\nwebsite: https://acme.example\n---\n# Acme\n\nNotes.\n',
  'Partners.csv': 'id,title,tier\n01JRT0ROW1000000000000000A,Globex,gold\n01JRT0ROW2000000000000000A,"Initech, Inc",silver\n',
};
const TRACKERS: Record<string, string> = {
  'partner.yaml': 'type: partner\ndisplayName: Partner\ndisplayNamePlural: Partners\nstorage: table\nfields:\n  - name: title\n    type: string\n  - name: tier\n    type: select\n',
  'competitor.yaml': 'type: competitor\ndisplayName: Competitor\ndisplayNamePlural: Competitors\nstorage: pages\nfields:\n  - name: title\n    type: string\n  - name: tier\n    type: select\n  - name: website\n    type: url\n',
};

interface ServerFile { syncId: string; relativePath: string; content: string; contentHash: string; lastModifiedAt: number; deleted: boolean }

/** The relay: stores the latest content per syncId and forwards every change to the other clients, like ProjectSyncRoom. */
class Relay {
  files = new Map<string, ServerFile>();
  private desktops: ProjectFileSyncService[] = [];

  attach(service: ProjectFileSyncService): void {
    this.desktops.push(service);
    const store = async (from: unknown, f: { syncId: string; content: string; relativePath: string; lastModifiedAt: number }) => {
      const file = { syncId: f.syncId, relativePath: f.relativePath, content: f.content, contentHash: sha256(f.content), lastModifiedAt: f.lastModifiedAt, deleted: false };
      this.files.set(f.syncId, file);
      await this.broadcast(from, (d) => (d as any).handleRemoteFileUpdate('proj', { ...file, title: path.posix.basename(file.relativePath), hasYjs: false }));
    };
    (service as any).provider = {
      pushFileContent: async (_p: string, syncId: string, content: string, relativePath: string, _t: string, lastModifiedAt: number) => {
        await store(service, { syncId, content, relativePath, lastModifiedAt });
        return { stored: [syncId], rejected: [], unconfirmed: [] };
      },
      pushFileBatch: async (_p: string, files: Array<{ syncId: string; content: string; relativePath: string; lastModifiedAt: number }>) => {
        for (const f of files) await store(service, f);
        return { stored: files.map((f) => f.syncId), rejected: [], unconfirmed: [] };
      },
      deleteFile: (_p: string, syncId: string) => this.remove(service, syncId),
      resync: vi.fn(),
      disconnectAll: vi.fn(),
    };
  }

  /** The phone's push: same wire as a desktop's. */
  async phonePush(relativePath: string, content: string, lastModifiedAt: number): Promise<void> {
    const syncId = sha256(relativePath);
    const file = { syncId, relativePath, content, contentHash: sha256(content), lastModifiedAt, deleted: false };
    this.files.set(syncId, file);
    await this.broadcast('phone', (d) => (d as any).handleRemoteFileUpdate('proj', { ...file, title: path.posix.basename(relativePath), hasYjs: false }));
  }

  private removing: Promise<void> = Promise.resolve();
  remove(from: unknown, syncId: string): Promise<void> {
    const file = this.files.get(syncId);
    if (file) file.deleted = true;
    this.removing = this.broadcast(from, (d) => (d as any).handleRemoteFileDelete('proj', syncId));
    return this.removing;
  }
  settled(): Promise<void> {
    return this.removing;
  }

  /** A (re)connect: the room diffs the client's manifest against what it holds. */
  async connect(service: ProjectFileSyncService, workspacePath: string): Promise<void> {
    const manifest: Array<{ syncId: string; contentHash: string; lastModifiedAt: number }> =
      await (service as any).buildManifest(workspacePath, 'proj', { seedBaseline: !(service as any).projectStates.has('proj') });
    const listed = new Set(manifest.map((m) => m.syncId));
    const wire = (f: ServerFile) => ({ ...f, title: path.posix.basename(f.relativePath), hasYjs: false });
    const response = { updatedFiles: [] as unknown[], newFiles: [] as unknown[], deletedSyncIds: [] as string[], needFromClient: [] as string[], yjsUpdates: [] };
    for (const m of manifest) {
      const held = this.files.get(m.syncId);
      if (!held) response.needFromClient.push(m.syncId);
      else if (held.deleted) response.deletedSyncIds.push(m.syncId);
      else if (held.contentHash !== m.contentHash) {
        if (held.lastModifiedAt > m.lastModifiedAt) response.updatedFiles.push(wire(held));
        else response.needFromClient.push(m.syncId);
      }
    }
    for (const held of this.files.values()) if (!held.deleted && !listed.has(held.syncId)) response.newFiles.push(wire(held));
    await (service as any).handleSyncResponse('proj', response);
  }

  private async broadcast(from: unknown, apply: (d: ProjectFileSyncService) => Promise<void>): Promise<void> {
    for (const d of this.desktops) if (d !== from) await apply(d);
  }
}

/** Every file of the wiki a reader sees: dot-names (the trash, the lock) skipped except the marker. */
async function wikiFiles(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.nimbalyst-wiki.yaml') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out[path.relative(root, abs).split(path.sep).join('/')] = await readFile(abs, 'utf-8');
    }
  };
  await walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function tree(workspacePath: string) {
  const lib = await openWiki(path.join(workspacePath, WIKI), { repair: false, typesDir: path.join(workspacePath, '.nimbalyst', 'trackers') });
  const snapshot = await lib.snapshot();
  return {
    pages: snapshot.pages.filter((p) => p.trashedAt === null).map(({ id, title, type, fields, parentId, order, path: p }) => ({ id, title, type, fields, parentId, order, path: p })),
    tables: snapshot.tables.map(({ typeId, path: p, parentId, rowCount }) => ({ typeId, path: p, parentId, rowCount })),
    issues: snapshot.issues.map((i) => i.code),
  };
}

const frontmatterOf = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).filter(([p]) => p.endsWith('.md')).map(([p, text]) => [p, splitFrontmatter(text).prefix]));

describe('Local wiki round trip: desktop A, desktop B and a phone', () => {
  let a: string;
  let b: string;
  let relay: Relay;
  let desktopA: ProjectFileSyncService;
  let desktopB: ProjectFileSyncService;

  beforeEach(async () => {
    a = await mkdtemp(path.join(os.tmpdir(), 'pfs-trip-a-'));
    b = await mkdtemp(path.join(os.tmpdir(), 'pfs-trip-b-'));
    // Type definitions do not travel over file sync; both checkouts have them (git).
    for (const ws of [a, b]) {
      await mkdir(path.join(ws, '.nimbalyst', 'trackers'), { recursive: true });
      for (const [name, text] of Object.entries(TRACKERS)) await writeFile(path.join(ws, '.nimbalyst', 'trackers', name), text, 'utf-8');
    }
    for (const [rel, text] of Object.entries(SEED)) {
      const abs = path.join(a, WIKI, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, text, 'utf-8');
    }
    relay = new Relay();
    desktopA = new ProjectFileSyncService();
    desktopB = new ProjectFileSyncService();
    relay.attach(desktopA);
    relay.attach(desktopB);
  });

  afterEach(async () => {
    desktopA.shutdown();
    desktopB.shutdown();
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  });

  it('ends with the same files, ids and tree on both desktops', async () => {
    const later = (s: number) => new Date(Date.now() + s * 1000);
    await relay.connect(desktopA, a);
    await relay.connect(desktopB, b);
    expect(await wikiFiles(path.join(b, WIKI))).toEqual(await wikiFiles(path.join(a, WIKI)));

    // A edits a page body in an editor (a file write the watcher reports).
    const home = path.join(a, WIKI, 'Home.md');
    await writeFile(home, `${await readFile(home, 'utf-8')}\nEdited on A.\n`, 'utf-8');
    await utimes(home, later(10), later(10));
    await desktopA.handleFileSaved(home, a, 'proj');

    // A moves the table under Projects: the watcher reports the unlink, then the add.
    const oldTable = path.join(a, WIKI, 'Partners.csv');
    const newTable = path.join(a, WIKI, 'Projects', 'Partners.csv');
    await rename(oldTable, newTable);
    desktopA.handleFileDeletedByPath(oldTable, a, 'proj');
    await relay.settled();
    await desktopA.handleFileSaved(newTable, a, 'proj');

    // The phone has every synced file, the table and the marker included.
    const onPhone = (rel: string) => [...relay.files.values()].find((f) => !f.deleted && f.relativePath === `${WIKI}/${rel}`)?.content;
    expect(onPhone('.nimbalyst-wiki.yaml')).toBe(SEED['.nimbalyst-wiki.yaml']);
    expect(onPhone('Projects/Partners.csv')).toBe(SEED['Partners.csv']);
    expect(onPhone('Partners.csv')).toBeUndefined();

    // The phone edits Launch's body; the iOS bundle re-serializes only the body.
    const launch = onPhone('Projects/Launch.md')!;
    const { prefix, body } = splitFrontmatter(launch);
    const edited = joinFrontmatter(prefix, `${body}\nEdited on the phone.\n`);
    expect(splitFrontmatter(edited).prefix).toBe(splitFrontmatter(SEED['Projects/Launch.md']).prefix);
    await relay.phonePush(`${WIKI}/Projects/Launch.md`, edited, later(60).getTime());

    // Both desktops reconnect; nothing old comes back.
    await relay.connect(desktopB, b);
    await relay.connect(desktopA, a);

    const filesA = await wikiFiles(path.join(a, WIKI));
    const filesB = await wikiFiles(path.join(b, WIKI));
    expect(filesB).toEqual(filesA);
    expect(frontmatterOf(filesB)).toEqual(frontmatterOf(SEED));
    expect(filesB['Projects/Launch.md']).toBe(edited);
    expect(filesB['Home.md']).toContain('Edited on A.');
    expect(Object.keys(filesB)).not.toContain('Partners.csv');
    expect(filesB['Projects/Partners.csv']).toBe(SEED['Partners.csv']);
    // B kept the old table in its wiki trash, never deleted it.
    const trash = await readdir(path.join(b, WIKI, '.trash'));
    expect(trash).toEqual([expect.stringMatching(/-table-partner$/)]);
    await expect(stat(path.join(a, WIKI, 'Partners.csv'))).rejects.toThrow();
    expect(relay.files.get(sha256(`${WIKI}/Partners.csv`))?.deleted).toBe(true);

    const treeA = await tree(a);
    expect(await tree(b)).toEqual(treeA);
    // Competitors/ has no Competitors.md, so it is a bare folder page with a derived `dir_` id.
    expect(treeA.pages.map((p) => p.id).filter((id) => !id.startsWith('dir_')).sort()).toEqual(
      ['01JRT0ACME00000000000000AA', '01JRT0HOME00000000000000AA', '01JRT0LAUNCH000000000000AA', '01JRT0PROJECTS0000000000AA'],
    );
    expect(treeA.tables).toEqual([{ typeId: 'partner', path: 'Projects/Partners.csv', parentId: '01JRT0PROJECTS0000000000AA', rowCount: 2 }]);
    expect(treeA.issues).toEqual([]);

    // The shared fixture is this wiki, so the Swift and Kotlin readers read the round-tripped files.
    if (process.env.UPDATE_WIKI_FIXTURES) {
      await rm(FIXTURE, { recursive: true, force: true });
      for (const [rel, text] of Object.entries(filesB)) {
        await mkdir(path.dirname(path.join(FIXTURE, 'wiki', rel)), { recursive: true });
        await writeFile(path.join(FIXTURE, 'wiki', rel), text, 'utf-8');
      }
      await cp(path.join(b, '.nimbalyst', 'trackers'), path.join(FIXTURE, 'trackers'), { recursive: true });
    }
    expect(await wikiFiles(path.join(FIXTURE, 'wiki'))).toEqual(filesB);
  });
});
