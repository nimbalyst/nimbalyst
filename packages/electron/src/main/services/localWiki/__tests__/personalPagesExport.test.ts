// @vitest-environment node
/**
 * Export of database Personal pages into the Local wiki, on the real SQLite
 * engine and a real wiki folder: every page is copied and read back, the
 * database rows are never touched, a mismatch stops the export, and a second
 * run copies nothing twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test'),
    getVersion: vi.fn(() => '1'),
    on: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../../HistoryManager', () => ({ historyManager: { createSnapshot: vi.fn() } }));

import { initWiki, openWiki, type LocalWiki } from '@nimbalyst/local-wiki';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { PersonalPagesService } from '../../PersonalPagesService';
import { PERSONAL_HOME_PAGE_ID, seedPersonalHomeOnce } from '../../personalPages/personalHomePage';
import { exportPersonalPages, legacyPersonalSnapshot, type ExportPhase } from '../personalPagesExport';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas');
const WS = '/ws/export';

let tmp: string;
let db: SQLiteDatabase;
let pages: PersonalPagesService;
let wikiRoot: string;
let wiki: LocalWiki | null;

async function openWikiFolder(): Promise<LocalWiki> {
  if (!wiki) {
    await initWiki(wikiRoot);
    wiki = await openWiki(wikiRoot);
  }
  return wiki;
}

async function rows(): Promise<unknown[]> {
  return (await db.query('SELECT * FROM personal_page_documents ORDER BY document_id')).rows;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-local-wiki-export-'));
  wikiRoot = path.join(tmp, 'wiki');
  wiki = null;
  db = new SQLiteDatabase({ dbDir: path.join(tmp, 'sqlite-db'), schemaDir: SCHEMA_DIR, slowQueryThresholdMs: 1000, sampleRate: 0 });
  await db.initialize();
  pages = new PersonalPagesService({ db: () => db, history: { createSnapshot: vi.fn(async () => undefined) }, notify: vi.fn() });
  const page = (documentId: string, title: string, parentFolderId: string | null = null) =>
    pages.command(WS, { type: 'register-document', documentId, title, documentType: 'markdown', parentFolderId });
  await page('p-specs', 'Specs');
  await page('p-intro', 'Intro: overview', 'p-specs');
  await page('p-old', 'Old notes');
  await pages.command(WS, { type: 'register-document', documentId: 'p-draw', title: 'Sketch', documentType: 'excalidraw', parentFolderId: null });
  await pages.updateBody(WS, 'p-specs', '# Specs\n\nSee [Intro](personal://p-intro).\n');
  await pages.updateBody(WS, 'p-intro', 'Intro body\n');
  await pages.updateBody(WS, 'p-draw', '{"type":"excalidraw","elements":[]}\n');
  await pages.command(WS, { type: 'set-document-fields', documentId: 'p-specs', fields: { status: 'current', tags: ['a', 'b'] } });
  await pages.command(WS, { type: 'trash-document', documentId: 'p-old', trashedAt: 1_700_000_000_000 });
  await seedPersonalHomeOnce(db, WS, { seeded: () => false, markSeeded: () => undefined });
  // A type page's prose is a row here too, but not a page of the tree.
  await pages.command(WS, { type: 'register-document', documentId: 'type-page:competitor', title: 'Competitors', documentType: 'markdown', parentFolderId: null });
});

afterEach(async () => {
  wiki?.close();
  await db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('exportPersonalPages', () => {
  it('copies pages, children, fields and trash into files, keeps the rows, and copies nothing twice', async () => {
    const before = await rows();
    const phases: ExportPhase[] = [];
    const emit = (phase: ExportPhase) => { phases.push(phase); };

    const legacy = await legacyPersonalSnapshot(db, WS, null);
    // The untouched seeded Home is not the user's.
    expect(legacy.items.map((item) => item.documentId).sort()).toEqual(['p-draw', 'p-intro', 'p-old', 'p-specs', 'type-page:competitor']);
    expect(legacy.unexportedPageCount).toBe(4);

    const report = await exportPersonalPages({ db, workspacePath: WS, wiki: openWikiFolder, emit });
    expect(report.ok).toBe(true);
    expect(phases).toEqual(['started', 'completed']);
    expect(report.exported.sort()).toEqual(['p-draw', 'p-intro', 'p-old', 'p-specs']);
    expect(report.skipped).toEqual([]);
    // A drawing keeps its own file and gets a sidecar for its id.
    expect(fs.readFileSync(path.join(wikiRoot, 'Sketch.excalidraw'), 'utf8')).toBe('{"type":"excalidraw","elements":[]}\n');
    expect(fs.readFileSync(path.join(wikiRoot, '.Sketch.excalidraw.wiki.yaml'), 'utf8')).toMatch(/^id: p-draw\ndocumentType: excalidraw\n/);

    const specs = fs.readFileSync(path.join(wikiRoot, 'Specs.md'), 'utf8');
    expect(specs).toMatch(/^---\nid: p-specs\n/);
    expect(specs).toContain('status: current');
    expect(specs.endsWith('# Specs\n\nSee [Intro](personal://p-intro).\n')).toBe(true);
    // A title that is not a valid file name is kept in frontmatter.
    const intro = fs.readFileSync(path.join(wikiRoot, 'Specs', 'Intro- overview.md'), 'utf8');
    expect(intro).toContain('title: \'Intro: overview\'');
    expect(intro.endsWith('Intro body\n')).toBe(true);
    const trashed = (await wiki!.snapshot()).pages.find((page) => page.id === 'p-old');
    expect(trashed?.trashedAt).toBe(1_700_000_000_000);
    expect(fs.existsSync(path.join(wikiRoot, 'Home.md'))).toBe(false);

    expect(await rows()).toEqual(before);
    expect((await legacyPersonalSnapshot(db, WS, await wiki!.snapshot())).unexportedPageCount).toBe(0);

    const again = await exportPersonalPages({ db, workspacePath: WS, wiki: openWikiFolder, emit });
    expect(again.ok).toBe(true);
    expect(again.exported).toEqual([]);
    expect(again.alreadyInWiki.sort()).toEqual(['p-draw', 'p-intro', 'p-old', 'p-specs']);
    expect(fs.readdirSync(wikiRoot).filter((name) => name.endsWith('.md')).sort()).toEqual(['Specs.md']);
  });

  it('stops at a read-back mismatch without touching the database or writing later pages', async () => {
    // A user who edited the seeded Home has something to keep.
    await pages.updateBody(WS, PERSONAL_HOME_PAGE_ID, 'My own home\n');
    const before = await rows();
    const phases: ExportPhase[] = [];
    const corrupting = async () => {
      const real = await openWikiFolder();
      return new Proxy(real, {
        get(target, key, receiver) {
          if (key === 'readBody') {
            return async (id: string) => ({ ...(await target.readBody(id)), markdown: 'something else' });
          }
          const value = Reflect.get(target, key, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    const report = await exportPersonalPages({ db, workspacePath: WS, wiki: corrupting, emit: (phase) => { phases.push(phase); } });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/read back differs/);
    expect(phases).toEqual(['started', 'failed']);
    expect(report.exported).toEqual([]);
    expect((await wiki!.snapshot()).pages).toHaveLength(1);
    expect(await rows()).toEqual(before);
  });
});
