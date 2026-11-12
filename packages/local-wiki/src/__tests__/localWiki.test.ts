// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import * as path from 'node:path';
import { CsvParseError, initWiki, LocalWiki, openWiki, parseCsv, stringifyCsv } from '../index.js';

let root: string;
let wiki: LocalWiki | null = null;

async function put(rel: string, text: string) {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), text);
}
const read = (rel: string) => readFile(path.join(root, rel), 'utf8');
const exists = (abs: string) => access(abs).then(() => true, () => false);
const ls = async (rel = '') => (await readdir(path.join(root, rel))).filter((n) => !n.startsWith('.')).sort();

async function open(options: Parameters<typeof openWiki>[1] = {}) {
  wiki = await openWiki(root, options);
  return wiki;
}

async function idOf(title: string) {
  const page = (await wiki!.snapshot()).pages.find((p) => p.title === title && p.trashedAt === null);
  if (!page) throw new Error(`no page ${title}`);
  return page.id;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'local-wiki-'));
  await initWiki(root);
});

afterEach(async () => {
  wiki?.close();
  wiki = null;
  await rm(root, { recursive: true, force: true });
});

describe('move and rename', () => {
  it('carries the child folder and rewrites links in and out of the moved pages', async () => {
    await put('Competitors.md', '---\nid: C\n---\n');
    await put('Competitors/Acme.md', '---\nid: A\n---\nSee [pricing](Acme/Pricing.md "id=P") and [home](../Home.md "id=H").\n');
    await put('Competitors/Acme/Pricing.md', '---\nid: P\n---\nBack to [Acme](../Acme.md "id=A").\n');
    await put('Home.md', '---\nid: H\n---\nRead [Acme](Competitors/Acme.md "id=A") and [plain](Competitors/Acme/Pricing.md).\n');
    await put('Archive.md', '---\nid: R\n---\n');
    await open();

    await wiki!.command({ type: 'move-document', documentId: 'A', parentFolderId: 'R' });
    expect(await ls('Archive')).toEqual(['Acme', 'Acme.md']);
    expect(await ls('Archive/Acme')).toEqual(['Pricing.md']);
    expect(await read('Home.md')).toContain('[Acme](Archive/Acme.md "id=A") and [plain](Archive/Acme/Pricing.md "id=P")');
    expect(await read('Archive/Acme.md')).toContain('[pricing](Acme/Pricing.md "id=P") and [home](../Home.md "id=H")');
    // A link inside the moved subtree to another moved page still resolves and is left alone.
    expect(await read('Archive/Acme/Pricing.md')).toContain('Back to [Acme](../Acme.md "id=A")');

    await wiki!.command({ type: 'update-document-title', documentId: 'A', title: 'Acme Corp' });
    expect(await ls('Archive')).toEqual(['Acme Corp', 'Acme Corp.md']);
    expect(await read('Home.md')).toContain('[Acme](Archive/Acme%20Corp.md "id=A") and [plain](Archive/Acme%20Corp/Pricing.md "id=P")');
    const snap = await wiki!.snapshot();
    expect(snap.pages.find((p) => p.id === 'P')).toMatchObject({ parentId: 'A', path: 'Archive/Acme Corp/Pricing.md' });
    expect(snap.issues).toEqual([]);
  });

  it('stores attachments in the page folder, dedupes them, and keeps their links through a rename and move', async () => {
    await put('Q3 Plan.md', '---\nid: Q\n---\n');
    await put('Archive.md', '---\nid: R\n---\n');
    await open();
    const bytes = new TextEncoder().encode('%PDF');
    const first = await wiki!.storeAttachment('Q', 'spec v2.pdf', bytes);
    expect(first).toEqual({ path: 'Q3 Plan/.assets/spec v2.pdf', link: 'Q3%20Plan/.assets/spec%20v2.pdf' });
    expect(await wiki!.storeAttachment('Q', 'spec v2.pdf', bytes)).toEqual(first);
    expect((await wiki!.storeAttachment('Q', '../spec v2.pdf', new TextEncoder().encode('other'))).path).toBe('Q3 Plan/.assets/spec v2 (2).pdf');
    // The hidden folder is not a page, and the page has no children.
    const snap = await wiki!.snapshot();
    expect(snap.pages.map((p) => p.title).sort()).toEqual(['Archive', 'Q3 Plan']);

    await wiki!.writeBody('Q', `![shot](Q3%20Plan/.assets/shot.png) and [spec](${first.link}) and [web](https://x.test/Q3%20Plan/a)\n`, null);
    await wiki!.command({ type: 'update-document-title', documentId: 'Q', title: 'Q4 Plan' });
    await wiki!.command({ type: 'move-document', documentId: 'Q', parentFolderId: 'R' });
    expect(await read('Archive/Q4 Plan.md')).toContain('![shot](Q4%20Plan/.assets/shot.png) and [spec](Q4%20Plan/.assets/spec%20v2.pdf) and [web](https://x.test/Q3%20Plan/a)');
    expect(await exists(path.join(root, 'Archive/Q4 Plan/.assets/spec v2.pdf'))).toBe(true);

    // A page's links resolve to files inside the wiki, never its bookkeeping or anything outside.
    expect(await wiki!.resolvePageFile('Q', 'Q4 Plan/.assets/spec v2.pdf')).toBe(path.join(root, 'Archive/Q4 Plan/.assets/spec v2.pdf'));
    expect(await wiki!.resolvePageFile('R', 'Archive/Q4 Plan/.assets/spec v2.pdf')).toBe(path.join(root, 'Archive/Q4 Plan/.assets/spec v2.pdf'));
    expect(await wiki!.resolvePageFile('Q', '../../outside.txt')).toBeNull();
    expect(await wiki!.resolvePageFile('Q', '../.nimbalyst-wiki.yaml')).toBeNull();
    expect(await wiki!.resolvePageFile('Q', 'Q4 Plan/.assets/missing.png')).toBeNull();
  });
});

describe('scan', () => {
  it('adopts files without ids in place, reads README as a folder body, and repairs a link moved outside the library', async () => {
    await put('Plain.md', '---\n# keep me\nstatus: draft\n---\nBody\n');
    await put('Imported/README.md', 'Folder body\n');
    await put('Bare/Child.md', '---\nid: K\n---\n');
    await put('Notes.md', '---\nid: N\n---\nSee [child](Bare/Child.md "id=K").\n');
    await open();
    expect(await read('Plain.md')).toMatch(/^---\nid: [0-9A-Z]{26}\n# keep me\nstatus: draft\n---\nBody\n$/);
    const snap = await wiki!.snapshot();
    const imported = snap.pages.find((p) => p.title === 'Imported')!;
    expect(imported).toMatchObject({ bodySource: 'readme', path: 'Imported/README.md', hasContent: true });
    expect((await wiki!.readBody(imported.id)).markdown).toBe('Folder body\n');
    expect(snap.pages.find((p) => p.title === 'Bare')).toMatchObject({ bodySource: 'none', path: null });
    expect(snap.pages.find((p) => p.id === 'K')!.parentId).toBe(snap.pages.find((p) => p.title === 'Bare')!.id);

    // Someone moves the file in Finder; the id still resolves, so the link is repointed.
    await mkdir(path.join(root, 'Elsewhere'));
    await writeFile(path.join(root, 'Elsewhere/Child.md'), await read('Bare/Child.md'));
    await rm(path.join(root, 'Bare'), { recursive: true });
    await wiki!.rescan();
    expect(await read('Notes.md')).toContain('[child](Elsewhere/Child.md "id=K")');
  });

  it('reports a malformed frontmatter file without throwing or rewriting it', async () => {
    const broken = '---\nid: [unclosed\ntitle: x\n---\nText\n';
    await put('Broken.md', broken);
    await put('Fine.md', '---\nid: F\n---\n');
    await open();
    const snap = await wiki!.snapshot();
    expect(snap.issues).toEqual([expect.objectContaining({ code: 'malformed-frontmatter', path: 'Broken.md' })]);
    const page = snap.pages.find((p) => p.path === 'Broken.md')!;
    expect(page.malformed).toBe(true);
    expect((await wiki!.readBody(page.id)).markdown).toBe(broken);
    await expect(wiki!.writeBody(page.id, 'new', null)).rejects.toMatchObject({ code: 'malformed' });
    await expect(wiki!.command({ type: 'set-document-fields', documentId: page.id, fields: { a: 1 } })).rejects.toMatchObject({ code: 'malformed' });
    await expect(wiki!.command({ type: 'update-document-title', documentId: page.id, title: 'Other' })).rejects.toMatchObject({ code: 'malformed' });
    expect(await read('Broken.md')).toBe(broken);
  });

  it('flattens a legacy trackerStatus block on the first field write', async () => {
    await put('Bug.md', '---\nid: B\ntrackerStatus:\n  type: bug\n  status: open\n---\nBody\n');
    await open();
    expect((await wiki!.snapshot()).pages.find((p) => p.id === 'B')).toMatchObject({ type: 'bug', fields: { status: 'open' } });
    await wiki!.command({ type: 'set-document-fields', documentId: 'B', fields: { priority: 'high' } });
    expect(await read('Bug.md')).toBe('---\nid: B\ntype: bug\nstatus: open\npriority: high\n---\nBody\n');
  });

  it('keeps the original id when a sync conflict copy sorts before it', async () => {
    await put('Acme.md', '---\nid: ACME\n---\nlocal edit\n');
    await put('Acme (conflict 2026-10-08 10.00.00).md', '---\nid: ACME\n---\nremote edit\n');
    await open();
    const byPath = Object.fromEntries((await wiki!.snapshot()).pages.map((p) => [p.path, p.id]));
    expect(byPath['Acme.md']).toBe('ACME');
    expect(byPath['Acme (conflict 2026-10-08 10.00.00).md']).not.toBe('ACME');
    expect(await read('Acme.md')).toBe('---\nid: ACME\n---\nlocal edit\n');
  });

  it('reads a duplicate under a path-derived id and re-keys it only on a write or after the grace period', async () => {
    let now = 1_000_000;
    const original = '---\nid: ACME\n---\nA\n';
    await put('Acme.md', original);
    // A sync rename whose add arrived before its delete, twice.
    await put('Moved/Acme.md', original);
    await put('Other/Acme.md', original);
    await open({ now: () => now });
    const idAt = async (p: string) => (await wiki!.snapshot()).pages.find((page) => page.path === p)!.id;
    const moved = await idAt('Moved/Acme.md');
    const other = await idAt('Other/Acme.md');
    expect(new Set([await idAt('Acme.md'), moved, other]).size).toBe(3);
    expect((await wiki!.snapshot()).issues).toContainEqual(expect.objectContaining({ code: 'duplicate-id', path: 'Moved/Acme.md', id: 'ACME' }));
    await wiki!.rescan();
    expect(await idAt('Moved/Acme.md')).toBe(moved);
    expect(await read('Moved/Acme.md')).toBe(original);
    expect(await read('Other/Acme.md')).toBe(original);

    // A command that writes to the copy gives it a stored id first.
    const { id: written } = await wiki!.command({ type: 'set-document-fields', documentId: moved, fields: { status: 'x' } });
    expect(written).toMatch(/^[0-9A-Z]{26}$/);
    expect(await read('Moved/Acme.md')).toBe(`---\nid: ${written}\nstatus: x\n---\nA\n`);
    expect(await read('Other/Acme.md')).toBe(original);

    now += 60_001;
    await wiki!.rescan();
    const rekeyed = await idAt('Other/Acme.md');
    expect(rekeyed).toMatch(/^[0-9A-Z]{26}$/);
    expect(await read('Other/Acme.md')).toBe(`---\nid: ${rekeyed}\n---\nA\n`);
    expect(await read('Acme.md')).toBe(original);
  });

  it('skips an add-id repair when another writer stored an id after the scan', async () => {
    await put('Plain.md', 'Body\n');
    class Racing extends LocalWiki {
      hook: (() => Promise<void>) | null = null;
      protected override async applyRepairs() {
        const hook = this.hook;
        this.hook = null;
        if (hook) await hook();
        return super.applyRepairs();
      }
    }
    const racing = new Racing(root, { formatVersion: 1 }, {});
    wiki = racing;
    racing.hook = () => put('Plain.md', '---\nid: THEIRS\n---\nBody\n');
    await racing.rescan();
    expect(await read('Plain.md')).toBe('---\nid: THEIRS\n---\nBody\n');
    expect((await racing.snapshot()).pages.map((p) => p.id)).toEqual(['THEIRS']);
  });

  it('quarantines a path-like id and keeps trash and restore inside the root', async () => {
    const outside = `${path.basename(root)}-escape`;
    const evil = `x/../../../${outside}`;
    await put('Evil.md', `---\nid: ${evil}\n---\nBody\n`);
    await put('Described.md', '---\nid: type-page:competitor\n---\n');
    await put(
      `.trash/5-T/${outside}.md`,
      '---\nid: T\n---\n',
    );
    await put(
      '.trash/5-T/.trash.json',
      JSON.stringify({ formatVersion: 1, kind: 'page', id: 'T', title: 'T', trashedAt: 5, originalParentId: null, originalDir: '..', entries: { md: `${outside}.md` } }),
    );
    await open();
    const snap = await wiki!.snapshot();
    const page = snap.pages.find((p) => p.path === 'Evil.md')!;
    expect(page.id).not.toBe(evil);
    expect(snap.issues).toContainEqual(expect.objectContaining({ code: 'unsafe-id', path: 'Evil.md' }));
    expect(snap.pages.find((p) => p.path === 'Described.md')!.id).toBe('type-page:competitor');

    await expect(wiki!.command({ type: 'trash-document', documentId: evil, trashedAt: 1000 })).rejects.toMatchObject({ code: 'invalid' });
    await expect(wiki!.writeBody(page.id, 'new', null)).rejects.toMatchObject({ code: 'malformed' });
    await expect(wiki!.command({ type: 'register-document', documentId: '../x', title: 'X', parentFolderId: null })).rejects.toMatchObject({ code: 'invalid' });
    await expect(wiki!.command({ type: 'restore-document', documentId: 'T' })).rejects.toMatchObject({ code: 'invalid' });

    expect(await read('Evil.md')).toBe(`---\nid: ${evil}\n---\nBody\n`);
    expect(await exists(path.join(root, '..', outside))).toBe(false);
    expect(await exists(path.join(root, '..', `${outside}.md`))).toBe(false);
    expect(await read(`.trash/5-T/${outside}.md`)).toBe('---\nid: T\n---\n');
  });
});

describe('names', () => {
  it('suffixes case-only clashes, keeps the title in frontmatter, and allows a case-only rename', async () => {
    await open();
    const { id: acme } = await wiki!.command({ type: 'register-document', title: 'Acme', parentFolderId: null });
    const { id: lower } = await wiki!.command({ type: 'register-document', title: 'acme', parentFolderId: null });
    const { id: slash } = await wiki!.command({ type: 'register-document', title: 'R/D: plans?', parentFolderId: null });
    expect(await ls()).toEqual(['Acme.md', 'R-D- plans-.md', 'acme (2).md']);
    expect(await read('acme (2).md')).toContain('title: acme\n');
    let pages = (await wiki!.snapshot()).pages;
    expect(pages.find((p) => p.id === lower)!.title).toBe('acme');
    expect(pages.find((p) => p.id === slash)!.title).toBe('R/D: plans?');

    await wiki!.command({ type: 'update-document-title', documentId: acme!, title: 'ACME' });
    expect(await ls()).toEqual(['ACME.md', 'R-D- plans-.md', 'acme (2).md']);
    pages = (await wiki!.snapshot()).pages;
    expect(pages.find((p) => p.id === acme)!.title).toBe('ACME');

    // A file renamed outside Nimbalyst takes its new name as its title.
    await writeFile(path.join(root, 'Renamed.md'), await read('acme (2).md'));
    await rm(path.join(root, 'acme (2).md'));
    await wiki!.rescan();
    expect((await wiki!.snapshot()).pages.find((p) => p.id === lower)!.title).toBe('Renamed');
  });

  it('merges frontmatter written in the body into the one block it creates', async () => {
    await open();
    const { id } = await wiki!.command({
      type: 'register-document',
      title: 'Pricing',
      parentFolderId: null,
      fields: { owner: 'greg' },
      body: '---\nid: ignored\ntype: decision\nstatus: open\nowner: someone\n---\n# Pricing\n',
    });
    const text = await read('Pricing.md');
    expect(text.match(/^---$/gm)).toHaveLength(2);
    expect(text).toMatch(new RegExp(`^---\\nid: ${id}\\ntype: decision\\norder: [\\d.]+\\nstatus: open\\nowner: greg\\n---\\n# Pricing\\n$`));
    const page = (await wiki!.snapshot()).pages.find((p) => p.id === id)!;
    expect(page.type).toBe('decision');

    await expect(wiki!.command({ type: 'register-document', title: 'Bad', parentFolderId: null, body: '---\n: [\n---\n' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await exists(path.join(root, 'Bad.md'))).toBe(false);
  });
});

describe('bodies', () => {
  it('rejects a write against a stale version and keeps the frontmatter', async () => {
    await put('Page.md', '---\nid: X\nstatus: draft\n---\nOne\n');
    await open();
    const first = await wiki!.readBody('X');
    expect(await wiki!.writeBody('X', 'Two\n', first.version)).toEqual({ ok: true, version: expect.any(String) });
    const stale = await wiki!.writeBody('X', 'Three\n', first.version);
    expect(stale).toMatchObject({ ok: false, reason: 'conflict', markdown: 'Two\n' });
    expect(await read('Page.md')).toBe('---\nid: X\nstatus: draft\n---\nTwo\n');
    // Field writes do not move the body version.
    const current = await wiki!.readBody('X');
    await wiki!.command({ type: 'set-document-fields', documentId: 'X', fields: { status: null, owner: 'kim' } });
    expect(await wiki!.writeBody('X', 'Four\n', current.version)).toMatchObject({ ok: true });
    expect(await read('Page.md')).toBe('---\nid: X\nowner: kim\n---\nFour\n');
  });

  it('lets one of two instances win a body write against the same version', async () => {
    await put('Page.md', '---\nid: X\n---\nOne\n');
    await open();
    const other = await openWiki(root);
    try {
      const base = (await wiki!.readBody('X')).version;
      const results = await Promise.all([wiki!.writeBody('X', 'Mine\n', base), other.writeBody('X', 'Theirs\n', base)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await exists(path.join(root, '.nimbalyst-wiki.lock'))).toBe(false);
    } finally {
      other.close();
    }
  });

  it('times out on a live write lock and takes over a stale one', async () => {
    await put('Page.md', '---\nid: X\n---\nOne\n');
    await open({ lockTimeoutMs: 100 });
    const lock = path.join(root, '.nimbalyst-wiki.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: Date.now() }));
    await expect(wiki!.writeBody('X', 'Two\n', null)).rejects.toMatchObject({ code: 'exists' });
    expect(await read('Page.md')).toBe('---\nid: X\n---\nOne\n');
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(lock, old, old);
    expect(await wiki!.writeBody('X', 'Two\n', null)).toMatchObject({ ok: true });
    expect(await exists(lock)).toBe(false);
  });
});

describe('trash', () => {
  it('moves a page and its children to .trash and restores under a clash suffix with links repaired', async () => {
    await put('Acme.md', '---\nid: A\n---\n');
    await put('Acme/Pricing.md', '---\nid: P\n---\n');
    await put('Home.md', '---\nid: H\n---\n[Acme](Acme.md "id=A")\n');
    await open();
    await wiki!.command({ type: 'trash-document', documentId: 'A', trashedAt: 1000 });
    expect(await ls()).toEqual(['Home.md']);
    expect((await readdir(path.join(root, '.trash/1000-A'))).sort()).toEqual(['.trash.json', 'Acme', 'Acme.md']);
    const snap = await wiki!.snapshot();
    // A markdown page is the built-in editor's, so hosts resolve it instead of showing it as unsupported.
    expect(snap.items.find((d) => d.documentId === 'A')).toMatchObject({ trashedAt: 1000, editorId: 'builtin.lexical' });
    expect(snap.pages.some((p) => p.id === 'P')).toBe(false);
    expect(snap.issues).toEqual([]);
    await expect(wiki!.command({ type: 'remove-document', documentId: 'H', purge: true })).rejects.toMatchObject({ code: 'not-trashed' });

    await wiki!.command({ type: 'register-document', title: 'Acme', parentFolderId: null });
    await wiki!.command({ type: 'restore-document', documentId: 'A' });
    expect(await ls()).toEqual(['Acme (2)', 'Acme (2).md', 'Acme.md', 'Home.md']);
    expect(await ls('.trash')).toEqual([]);
    const restored = (await wiki!.snapshot()).pages.find((p) => p.id === 'A')!;
    expect(restored).toMatchObject({ title: 'Acme', trashedAt: null, path: 'Acme (2).md' });
    expect(await read('Home.md')).toContain('[Acme](Acme%20%282%29.md "id=A")');
  });
});

describe('editor pages', () => {
  const lsAll = async (rel = '') => (await readdir(path.join(root, rel))).filter((n) => n !== '.nimbalyst-wiki.yaml').sort();

  it('creates a drawing with a sidecar, versions its raw text, and carries the sidecar through rename, move, trash and restore', async () => {
    await put('Home.md', '---\nid: H\n---\n');
    await put('Archive.md', '---\nid: R\n---\n');
    await open();
    const { id } = await wiki!.command({ type: 'register-document', title: 'Flow', parentFolderId: null, documentType: 'excalidraw', body: '{"elements":[]}' });
    expect(await lsAll()).toEqual(['.Flow.excalidraw.wiki.yaml', 'Archive.md', 'Flow.excalidraw', 'Home.md']);
    expect(await read('.Flow.excalidraw.wiki.yaml')).toBe(`id: ${id}\ndocumentType: excalidraw\norder: 1000\n`);
    expect((await wiki!.snapshot()).items.find((d) => d.documentId === id)).toMatchObject({ title: 'Flow', documentType: 'excalidraw', fileExtension: '.excalidraw', editorId: 'excalidraw' });
    await expect(wiki!.command({ type: 'set-document-type', documentId: id!, pageType: 'bug' })).rejects.toMatchObject({ code: 'invalid' });

    const first = await wiki!.readBody(id!);
    expect(first.markdown).toBe('{"elements":[]}');
    expect(await wiki!.writeBody(id!, '{"elements":[1]}', first.version)).toMatchObject({ ok: true });
    expect(await wiki!.writeBody(id!, 'stale', first.version)).toMatchObject({ ok: false, markdown: '{"elements":[1]}' });

    await wiki!.writeBody('H', `See [Flow](Flow.excalidraw "id=${id}").\n`, null);
    await put('Flow/Notes.md', '---\nid: N\n---\n');
    await wiki!.command({ type: 'move-document', documentId: id!, parentFolderId: 'R' });
    await wiki!.command({ type: 'update-document-title', documentId: id!, title: 'Flow: v2' });
    expect(await lsAll('Archive')).toEqual(['.Flow- v2.excalidraw.wiki.yaml', 'Flow- v2', 'Flow- v2.excalidraw']);
    expect(await read('Archive/.Flow- v2.excalidraw.wiki.yaml')).toContain("title: 'Flow: v2'\n");
    expect(await read('Home.md')).toContain(`[Flow](Archive/Flow-%20v2.excalidraw "id=${id}")`);
    let snap = await wiki!.snapshot();
    expect(snap.pages.find((p) => p.id === 'N')).toMatchObject({ parentId: id, path: 'Archive/Flow- v2/Notes.md' });
    expect(snap.pages.find((p) => p.id === id)).toMatchObject({ title: 'Flow: v2', parentId: 'R' });

    await wiki!.command({ type: 'trash-document', documentId: id!, trashedAt: 5 });
    expect(await lsAll('Archive')).toEqual([]);
    expect((await wiki!.readBody(id!)).markdown).toBe('{"elements":[1]}');
    await wiki!.command({ type: 'restore-document', documentId: id! });
    snap = await wiki!.snapshot();
    expect(snap.pages.find((p) => p.id === id)).toMatchObject({ documentType: 'excalidraw', path: 'Archive/Flow- v2.excalidraw', title: 'Flow: v2' });
    expect(snap.issues).toEqual([]);
  });

  it('adopts a hand-added editor file, keeps table CSVs apart from spreadsheets, and reports a sidecar without its file', async () => {
    const typesDir = path.join(root, '..', `${path.basename(root)}-types`);
    await mkdir(typesDir, { recursive: true });
    await writeFile(path.join(typesDir, 'partner.yaml'), 'type: partner\ndisplayName: Partner\ndisplayNamePlural: Partners\nstorage: table\nfields:\n  - name: title\n    type: string\n');
    await put('Map.mindmap', '{"root":{"text":"ideas"}}');
    await put('Partners.csv', 'id,title\nP1,Globex\n');
    await put('Budget.csv', 'month,amount\nJan,10\n');
    await put('.Gone.excalidraw.wiki.yaml', 'id: G\n');
    try {
      await open({ typesDir });
      const sidecar = await read('.Map.mindmap.wiki.yaml');
      expect(sidecar).toMatch(/^id: [0-9A-Z]{26}\ndocumentType: mindmap\n$/);
      const snap = await wiki!.snapshot();
      const byTitle = Object.fromEntries(snap.pages.map((p) => [p.title, p]));
      expect(byTitle.Map).toMatchObject({ documentType: 'mindmap', path: 'Map.mindmap', id: sidecar.slice(4, 30) });
      expect(byTitle.Budget).toMatchObject({ documentType: 'csv', path: 'Budget.csv' });
      expect(byTitle.Partners).toBeUndefined();
      expect(snap.tables).toEqual([expect.objectContaining({ typeId: 'partner', path: 'Partners.csv' })]);
      expect(snap.issues).toEqual([expect.objectContaining({ code: 'orphan-sidecar', path: '.Gone.excalidraw.wiki.yaml' })]);
      expect(await read('.Gone.excalidraw.wiki.yaml')).toBe('id: G\n');
      expect((await wiki!.search('ideas')).map((h) => h.title)).toEqual(['Map']);
      // A new markdown page cannot take a stem an editor page holds.
      await wiki!.command({ type: 'register-document', title: 'Map', parentFolderId: null });
      expect(await ls()).toContain('Map (2).md');
    } finally {
      await rm(typesDir, { recursive: true, force: true });
    }
  });
});

describe('csv', () => {
  it('reads BOM, CRLF, quoted empties and blank lines, and refuses an unterminated quote', () => {
    expect(parseCsv('﻿id,a\r\n1,""\r\n\r\n2,"x\r\ny",\n')).toEqual([['id', 'a'], ['1', ''], ['2', 'x\r\ny', '']]);
    const rows = [['id', 'v'], ['1', ' padded '], ['2', 'a,"b"']];
    expect(parseCsv(stringifyCsv(rows))).toEqual(rows);
    expect(() => parseCsv('id\n"open')).toThrow(CsvParseError);
  });
});

describe('table types', () => {
  async function withPartnerType(storage = 'table') {
    const typesDir = path.join(root, '..', `${path.basename(root)}-types`);
    await mkdir(typesDir, { recursive: true });
    await writeFile(
      path.join(typesDir, 'partner.yaml'),
      `type: partner\ndisplayName: Partner\ndisplayNamePlural: Partners\nstorage: ${storage}\nfields:\n  - name: title\n    type: string\n  - name: tier\n    type: select\n  - name: tags\n    type: array\n    itemType: string\n  - name: seats\n    type: number\n  - name: owner\n    type: relationship\n`,
    );
    return typesDir;
  }

  afterEach(async () => {
    await rm(path.join(root, '..', `${path.basename(root)}-types`), { recursive: true, force: true });
  });

  it('keeps a wikiId another instance stored when placing a table', async () => {
    const typesDir = await withPartnerType();
    await put('Ops.md', '---\nid: O\n---\n');
    await open({ typesDir });
    const other = await openWiki(root, { typesDir });
    const id = await other.wikiId();
    other.close();
    expect(id).toMatch(/^[0-9A-Z]{26}$/);
    await wiki!.command({ type: 'set-type-placement', typeId: 'partner', parentFolderId: 'O', sortOrder: 500 });
    const reopened = await openWiki(root, { typesDir });
    expect(await reopened.wikiId()).toBe(id);
    reopened.close();
    expect(await read('.nimbalyst-wiki.yaml')).toContain('order: 500');
  });

  it('round-trips rows with quotes, newlines, commas and ; through the CSV', async () => {
    const typesDir = await withPartnerType();
    await put('Ops.md', '---\nid: O\n---\n');
    await open({ typesDir });
    await wiki!.command({ type: 'set-type-placement', typeId: 'partner', parentFolderId: 'O', sortOrder: 500 });
    const tricky = 'Say "hi",\nthen leave';
    const { id } = await wiki!.trackerCommand('partner', {
      type: 'create-item',
      item: { title: tricky, fields: { tags: ['a;b', 'c\\d', 'e'], seats: 12, owner: { itemId: 'O' } } },
    });
    expect(await read('Ops/Partners.csv')).toBe(`id,title,tier,tags,seats,owner\n${id},"Say ""hi"",\nthen leave",,a\\;b;c\\\\d;e,12,O\n`);
    const snap = await wiki!.trackerSnapshot('partner');
    expect(snap.items).toEqual([expect.objectContaining({ id, title: tricky, parentId: 'O', fields: { title: tricky, tags: ['a;b', 'c\\d', 'e'], seats: 12, owner: 'O' } })]);
    expect((await wiki!.snapshot()).typePlacements).toEqual([expect.objectContaining({ typeId: 'partner', parentFolderId: 'O', sortOrder: 500 })]);

    await wiki!.trackerCommand('partner', { type: 'update-item', input: { itemId: id!, updates: { tier: 'gold', seats: null } } });
    expect((await wiki!.trackerSnapshot('partner')).items[0].fields).toMatchObject({ tier: 'gold' });
    expect((await wiki!.trackerSnapshot('partner')).items[0].fields.seats).toBeUndefined();
    expect((await wiki!.readActivity(id!)).map((e) => e.action)).toEqual(['create', 'update']);
    expect((await wiki!.search('leave')).map((h) => h.id)).toEqual([id]);

    await wiki!.trackerCommand('partner', { type: 'delete-item', itemId: id! });
    expect((await wiki!.trackerSnapshot('partner')).items).toEqual([]);
    await wiki!.command({ type: 'restore-document', documentId: id! });
    expect((await wiki!.trackerSnapshot('partner')).items[0]).toMatchObject({ id, title: tricky, fields: { tier: 'gold' } });
  });

  it('does not overwrite a CSV another instance created after this one scanned', async () => {
    const typesDir = await withPartnerType();
    await open({ typesDir });
    const other = await openWiki(root, { typesDir });
    try {
      const { id: theirs } = await other.trackerCommand('partner', { type: 'create-item', item: { title: 'Globex' } });
      const { id: mine } = await wiki!.trackerCommand('partner', { type: 'create-item', item: { title: 'Initech' } });
      expect((await wiki!.trackerSnapshot('partner')).items.map((i) => i.id)).toEqual([theirs, mine]);
      expect(await ls()).toEqual(['Partners.csv', 'Partners.activity.jsonl'].sort());
    } finally {
      other.close();
    }
  });

  it('assigns ids to hand-added rows and converts a table into pages', async () => {
    const typesDir = await withPartnerType();
    await put('Partners.csv', 'id,title,tier\nR1,Globex,gold\n,Initech,\n');
    await open({ typesDir });
    const rows = (await wiki!.trackerSnapshot('partner')).items;
    expect(rows.map((r) => r.title)).toEqual(['Globex', 'Initech']);
    expect(rows[1].id).toMatch(/^[0-9A-Z]{26}$/);

    const result = await wiki!.convertTableToPages('partner');
    expect(result).toEqual({ created: ['R1', rows[1].id], typeFileUpdated: true });
    expect(await ls()).toEqual(['Globex.md', 'Initech.md']);
    expect(await read('Globex.md')).toBe('---\nid: R1\ntype: partner\norder: 1000\ntier: gold\n---\n');
    expect(await readFile(path.join(typesDir, 'partner.yaml'), 'utf8')).toContain('storage: pages\n');
    expect((await wiki!.trackerSnapshot('partner')).items.map((i) => i.title).sort()).toEqual(['Globex', 'Initech']);
  });

  it('converts a nested table with a commented storage line, keeping ids, every field value and activity', async () => {
    const typesDir = await withPartnerType('table   # or pages');
    await put('Ops.md', '---\nid: O\n---\n');
    await put('Ops/Partners.csv', 'id,title,tier,tags,seats,owner,extra\nR1,Globex,gold,a;b\\;c,12,O,kept\nR2,"Say ""hi""",,,,,\n');
    await open({ typesDir });
    await wiki!.trackerCommand('partner', { type: 'update-item', input: { itemId: 'R1', updates: { tier: 'silver' } } });
    const before = (await wiki!.trackerSnapshot('partner')).items.map(({ id, title, fields }) => ({ id, title, fields }));

    expect((await wiki!.convertTableToPages('partner')).typeFileUpdated).toBe(true);
    expect(await readFile(path.join(typesDir, 'partner.yaml'), 'utf8')).toContain('storage: pages   # or pages\n');
    expect(await ls('Ops')).toEqual(['Globex.md', 'Globex.activity.jsonl', 'Say -hi-.md'].sort());
    const after = await wiki!.trackerSnapshot('partner');
    expect(after.storage).toBe('pages');
    expect(after.items.map(({ id, title, fields }) => ({ id, title, fields })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      before.map(({ id, title, fields }) => ({ id, title, fields: Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'title')) })),
    );
    expect(after.items.every((item) => item.parentId === 'O')).toBe(true);
    expect((await wiki!.readActivity('R1')).map((e) => e.action)).toEqual(['update']);
  });

  it('reports a wiki type field whose name the tracker model keeps for item metadata', async () => {
    const typesDir = await withPartnerType('pages');
    await writeFile(path.join(typesDir, 'competitor.yaml'), 'type: competitor\nstorage: pages\nfields:\n  - name: activity\n    type: select\n  - name: threat\n    type: select\n');
    await writeFile(path.join(typesDir, 'bug.yaml'), 'type: bug\nfields:\n  - name: source\n    type: string\n');
    await put('Acme.md', '---\nid: A\ntype: competitor\nactivity: active\n---\n');
    await open({ typesDir });
    const issues = (await wiki!.snapshot()).issues.filter((issue) => issue.code === 'reserved-field');
    // Only wiki types: an app type's items never pass through the wiki.
    expect(issues).toEqual([expect.objectContaining({ path: path.join(typesDir, 'competitor.yaml'), message: expect.stringContaining('"activity"') })]);
    // The value stays in the file and in the library's model; nothing is dropped on read.
    expect((await wiki!.trackerSnapshot('competitor')).items[0].fields).toEqual({ activity: 'active' });
  });

  it('stops a conversion whose activity log cannot be read, before anything goes to trash', async () => {
    const typesDir = await withPartnerType();
    await put('Partners.csv', 'id,title\nR1,Globex\n');
    await put('Partners.activity.jsonl', '{"at":"x","itemId":"R1","action":"create"}\n');
    await open({ typesDir });
    await chmod(path.join(root, 'Partners.activity.jsonl'), 0o000);
    try {
      await expect(wiki!.convertTableToPages('partner')).rejects.toThrow();
    } finally {
      await chmod(path.join(root, 'Partners.activity.jsonl'), 0o644);
    }
    expect(await ls()).toContain('Partners.csv');
    expect(await ls()).toContain('Partners.activity.jsonl');
    expect(await readFile(path.join(typesDir, 'partner.yaml'), 'utf8')).toContain('storage: table\n');
  });

  it('resumes a conversion that failed at the type file: one page per id, activity copied once', async () => {
    const typesDir = await withPartnerType();
    await put('Partners.csv', 'id,title,tier\nR1,Acme,gold\nR2,Globex,\n');
    await put('Partners.activity.jsonl', '{"at":"x","itemId":"R1","action":"create"}\n');
    await open({ typesDir });
    await chmod(typesDir, 0o555);
    try {
      await expect(wiki!.convertTableToPages('partner')).rejects.toThrow();
    } finally {
      await chmod(typesDir, 0o755);
    }
    // Partial output: the pages exist, the CSV and type are untouched.
    expect(await ls()).toContain('Partners.csv');
    await put('Acme.md', (await read('Acme.md')) + 'Notes added between the two runs.\n');

    expect((await wiki!.convertTableToPages('partner')).created).toEqual(['R1', 'R2']);
    expect(await ls()).toEqual(['Acme.activity.jsonl', 'Acme.md', 'Globex.md']);
    expect(await read('Acme.md')).toBe('---\nid: R1\ntype: partner\norder: 1000\ntier: gold\n---\nNotes added between the two runs.\n');
    expect((await wiki!.readActivity('R1')).map((e) => e.action)).toEqual(['create']);
    expect((await wiki!.trackerSnapshot('partner')).items.map((i) => i.id).sort()).toEqual(['R1', 'R2']);
  });

  it('refuses to resume over a partial page whose fields were edited since, naming the page and fields', async () => {
    const typesDir = await withPartnerType();
    await put('Partners.csv', 'id,title,tier\nR1,Acme,gold\nR2,Globex,\n');
    await open({ typesDir });
    await chmod(typesDir, 0o555);
    try {
      await expect(wiki!.convertTableToPages('partner')).rejects.toThrow();
    } finally {
      await chmod(typesDir, 0o755);
    }
    const edited = (await read('Acme.md')).replace('tier: gold', 'tier: silver').replace('---\n', '---\nnote: keep me\n');
    await put('Acme.md', edited);

    await expect(wiki!.convertTableToPages('partner')).rejects.toThrow(/Acme\.md.*(note.*tier|tier.*note)/s);
    expect(await read('Acme.md')).toBe(edited);
    expect(await ls()).toContain('Partners.csv');
    expect(await readFile(path.join(typesDir, 'partner.yaml'), 'utf8')).toContain('storage: table\n');
  });

  it('refuses to resume over a partial page renamed since, rather than undoing the rename', async () => {
    const typesDir = await withPartnerType();
    await put('Partners.csv', 'id,title,tier\nR1,Acme,gold\n');
    await open({ typesDir });
    await chmod(typesDir, 0o555);
    try {
      await expect(wiki!.convertTableToPages('partner')).rejects.toThrow();
    } finally {
      await chmod(typesDir, 0o755);
    }
    await wiki!.command({ type: 'update-document-title', documentId: 'R1', title: 'Acme Corp' });
    const renamed = await read('Acme Corp.md');

    await expect(wiki!.convertTableToPages('partner')).rejects.toThrow(/Acme Corp\.md \(title\)/);
    expect(await ls()).toEqual(['Acme Corp.md', 'Partners.csv']);
    expect(await read('Acme Corp.md')).toBe(renamed);
    expect(await readFile(path.join(typesDir, 'partner.yaml'), 'utf8')).toContain('storage: table\n');
  });

  it('refuses to convert when the type file cannot be flipped, leaving the CSV in place', async () => {
    const typesDir = await withPartnerType();
    await writeFile(path.join(typesDir, 'partner.yaml'), 'type: partner\ndisplayNamePlural: Partners\n"storage": "table"\nfields: [{ name: title }]\n');
    await put('Partners.csv', 'id,title\nR1,Globex\n');
    await open({ typesDir });
    await expect(wiki!.convertTableToPages('partner')).rejects.toThrow(/storage/);
    expect(await ls()).toEqual(['Partners.csv']);
  });
});

describe('watch', () => {
  it('starts watching a types folder created after watch began, and says when types changed', async () => {
    const typesDir = path.join(root, '..', `${path.basename(root)}-late-types`);
    const watched = new Map<string, () => void>();
    await open({
      typesDir,
      debounceMs: 5,
      typesPollMs: 5,
      // As fs.watch: a folder that does not exist cannot be watched.
      watchFactory: (dir, onEvent) => {
        if (!existsSync(dir)) throw new Error('ENOENT');
        watched.set(dir, onEvent);
        return { close: () => watched.delete(dir) };
      },
    });
    const changes: unknown[] = [];
    const stop = wiki!.watch((change) => changes.push(change));
    try {
      expect([...watched.keys()]).toEqual([root]);
      await mkdir(typesDir);
      await writeFile(path.join(typesDir, 'partner.yaml'), 'type: partner\nstorage: table\n');
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect([...watched.keys()].sort()).toEqual([root, typesDir].sort());
      expect(wiki!.typeDefs().map((def) => def.typeId)).toEqual(['partner']);
      expect(changes).toEqual([{ changedIds: [], removedIds: [], tableTypes: [], typesChanged: true }]);

      await writeFile(path.join(typesDir, 'partner.yaml'), 'type: partner\nstorage: pages\n');
      watched.get(typesDir)!();
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(changes).toHaveLength(2);
      expect(wiki!.typeDefs()[0].storage).toBe('pages');
    } finally {
      stop();
      await rm(typesDir, { recursive: true, force: true });
    }
  });

  it('reports an edit made while the watcher was still starting, which the watcher never saw', async () => {
    await put('A.md', '---\nid: A\n---\n');
    // As FSEvents under load: the watch is open, but a change made right away is never delivered.
    await open({ debounceMs: 5, watchCatchUpMs: [20], watchFactory: () => ({ close() {} }) });
    const changes: unknown[] = [];
    const stop = wiki!.watch((change) => changes.push(change));
    await put('A.md', '---\nid: A\n---\nedited right after the watch began\n');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(changes).toEqual([{ changedIds: ['A'], removedIds: [], tableTypes: [] }]);
    stop();
  });

  it('debounces file events into one change notification', async () => {
    let fire: () => void = () => {};
    await put('A.md', '---\nid: A\n---\n');
    await open({ debounceMs: 5, watchFactory: (_dir, onEvent) => ((fire = onEvent), { close() {} }) });
    const changes: unknown[] = [];
    const stop = wiki!.watch((change) => changes.push(change));
    await put('A.md', '---\nid: A\n---\nedited\n');
    await put('B.md', '---\nid: B\n---\n');
    fire();
    fire();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await wiki!.snapshot();
    expect(changes).toEqual([{ changedIds: ['A', 'B'], removedIds: [], tableTypes: [] }]);
    stop();
  });

  it('notifies when the first page is created in an empty wiki', async () => {
    await open();
    const changes: Array<{ changedIds: string[] }> = [];
    const stop = wiki!.watch((change) => changes.push(change));
    await wiki!.command({ type: 'register-document', title: 'A', parentFolderId: null } as never);
    expect(changes).toHaveLength(1);
    expect(changes[0].changedIds).toHaveLength(1);
    stop();
  });
});
