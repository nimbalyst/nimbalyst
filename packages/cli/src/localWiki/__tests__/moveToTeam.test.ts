// @vitest-environment node
/**
 * Moving a real local wiki to a team project against a fake `pages_import`
 * that upserts on localId like the server does: links rewritten to team links,
 * batches paced and retried on 429, `migratedTo` written only after a verified
 * import, and a re-run after a partial failure resuming without duplicates.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ExitCode } from '../../cli/exitCodes.js';
import { PagesToolError } from '../../cloud/pagesClient.js';
import { readMigratedTo } from '../locate.js';
import { initLocalWiki, openLocalWiki, type OpenedWiki } from '../open.js';
import { moveLocalWikiToTeam } from '../moveToTeam.js';

const dirs: string[] = [];
const wikis: OpenedWiki[] = [];
afterEach(() => {
  for (const opened of wikis.splice(0)) opened.wiki.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROJECT = { orgId: 'org_1', projectId: 'proj_1' };
const HOME_LINK = 'https://console.nimbalyst.com/org/org_1/project/proj_1/document/home';

async function makeWiki(): Promise<OpenedWiki> {
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-move-')));
  dirs.push(project);
  mkdirSync(path.join(project, '.nimbalyst'), { recursive: true });
  writeFileSync(path.join(project, '.nimbalyst', 'wiki.json'), JSON.stringify(PROJECT));
  (await initLocalWiki(project)).wiki.close();
  const opened = await openLocalWiki(project);
  wikis.push(opened);
  return opened;
}

interface FakeServer {
  calls: Array<{ name: string; args: any }>;
  pages: Map<string, any>;
  call: (name: string, args: Record<string, unknown>) => Promise<any>;
  /** Fail these localIds on the next import that carries them. */
  failOnce: Set<string>;
  /** Answer 429 to this many pages_import calls first. */
  rateLimits: number;
  /** Map these localIds but refuse them as another document type, as the server does. */
  typeMismatch: Set<string>;
  typePlacements: Map<string, any>;
}

function fakeServer(): FakeServer {
  const server: FakeServer = {
    calls: [],
    pages: new Map(),
    typePlacements: new Map(),
    failOnce: new Set(),
    rateLimits: 0,
    typeMismatch: new Set(),
    call: async (name, args) => {
      server.calls.push({ name, args: structuredClone(args) });
      if (name === 'pages_status') {
        return { state: 'bound', user: { email: 'a@b.c' }, project: { ...PROJECT, projectName: 'Acme' }, homeLink: HOME_LINK };
      }
      if (name === 'readCollabDoc') return { markdown: 'home' };
      if (name !== 'pages_import') throw new Error(`unexpected ${name}`);
      if (server.rateLimits > 0) {
        server.rateLimits--;
        throw new PagesToolError(ExitCode.CONNECTION, 'pages_import: rate limited', 'rate_limited', 10_000);
      }
      const idMap: Record<string, unknown> = {};
      const errors: unknown[] = [];
      let created = 0;
      let updated = 0;
      for (const placement of (args as any).typePlacements ?? []) server.typePlacements.set(placement.typeId, placement);
      for (const page of (args as any).pages) {
        if (server.failOnce.delete(page.localId)) {
          errors.push({ localId: page.localId, code: 'internal', message: 'boom' });
          continue;
        }
        const typed = page.kind === 'typedPage';
        if (server.typeMismatch.has(page.localId)) {
          errors.push({ localId: page.localId, code: 'document_type_mismatch', message: 'another type' });
        } else if (server.pages.has(page.localId)) updated++;
        else created++;
        server.pages.set(page.localId, page);
        // The server writes the page `homeLocalId` names into the project's Home.
        const id = page.localId === (args as any).homeLocalId ? 'home:proj_1' : `t-${page.localId}`;
        idMap[page.localId] = {
          nodeId: `${typed ? 'item' : 'document'}:${id}`,
          id,
          link: `https://console.nimbalyst.com/org/org_1/project/proj_1/document/${id}`,
          uri: `collab://org:org_1:doc:${id}`,
        };
      }
      return { idMap, created, updated, errors };
    },
  };
  return server;
}

const noWait = { sleep: async () => {}, minIntervalMs: 0 };

describe('moveLocalWikiToTeam', () => {
  it('rewrites links between pages to their team links and re-sends only the bodies that changed', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    const acme = (await wiki.command({ type: 'register-document', title: 'Acme', parentFolderId: null, body: 'Plain body.\n' })).id!;
    const pricing = (await wiki.command({ type: 'register-document', title: 'Pricing', parentFolderId: acme, body: 'Back to [Acme](../Acme.md "id=' + acme + '").\n' })).id!;
    const notes = (await wiki.command({ type: 'register-document', title: 'Notes', parentFolderId: null, body: 'See [pricing](Acme/Pricing.md#tiers) and [docs](https://example.com) and `[x](Acme.md)`.\n' })).id!;
    const server = fakeServer();

    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });

    const link = (id: string) => `https://console.nimbalyst.com/org/org_1/project/proj_1/document/t-${id}`;
    expect(server.pages.get(pricing).body).toBe(`Back to [Acme](${link(acme)}).\n`);
    // Path-only link resolved relative to the page; fragment kept; external links and code untouched.
    expect(server.pages.get(notes).body).toBe(`See [pricing](${link(pricing)}#tiers) and [docs](https://example.com) and \`[x](Acme.md)\`.\n`);
    const imports = server.calls.filter((c) => c.name === 'pages_import');
    expect(imports).toHaveLength(2);
    expect(imports[1].args.pages.map((p: any) => p.localId).sort()).toEqual([notes, pricing].sort());
    // A child comes after its parent and names it.
    const first = imports[0].args.pages.map((p: any) => p.localId);
    expect(first.indexOf(acme)).toBeLessThan(first.indexOf(pricing));
    expect(imports[0].args.pages.find((p: any) => p.localId === pricing).parentLocalId).toBe(acme);
    expect(imports[0].args.source.wikiId).toMatch(/^[0-9A-Z]{26}$/);
    expect(report).toMatchObject({ verified: true, linksRewritten: 2, counts: { pages: 4 }, homeLink: expect.stringMatching(/\/document\/home:proj_1$/) });
    // No page body in what goes back to the agent.
    expect(JSON.stringify(report)).not.toContain('Plain body');
  });

  it('sends 50 pages per call, spaced out, and waits out a 429 before retrying', async () => {
    const opened = await makeWiki();
    // Files written straight into the folder: 120 command() calls would each take the write lock.
    for (let i = 0; i < 120; i++) writeFileSync(path.join(opened.dir, `Page ${i}.md`), `---\nid: p${i}\n---\nx\n`);
    await opened.wiki.rescan();
    const server = fakeServer();
    server.rateLimits = 2;
    let clock = 0;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    };

    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, sleep, now: () => clock, minIntervalMs: 300 });

    const imports = server.calls.filter((c) => c.name === 'pages_import');
    // 2 refused, then 3 batches of 50/50/21 (120 pages plus Home).
    expect(imports.map((c) => c.args.pages.length)).toEqual([50, 50, 50, 50, 21]);
    expect(sleeps.filter((ms) => ms === 10_000)).toHaveLength(2);
    expect(sleeps.every((ms) => ms === 300 || ms === 10_000)).toBe(true);
    expect(report).toMatchObject({ verified: true, created: 121, updated: 0, batches: 3 });
  });

  it('gives up after repeated 429s without marking the wiki moved', async () => {
    const opened = await makeWiki();
    const server = fakeServer();
    server.rateLimits = 100;
    await expect(moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait, maxAttempts: 3 })).rejects.toThrow(/rate limited/);
    expect(server.calls.filter((c) => c.name === 'pages_import')).toHaveLength(3);
    expect(readMigratedTo(opened.projectRoot)).toBeUndefined();
  });

  it('writes migratedTo and the Home banner only after a verified import, keeping the location setting', async () => {
    const opened = await makeWiki();
    const server = fakeServer();
    const homeId = (await opened.wiki.snapshot()).pages.find((p) => p.title === 'Home')!.id;
    const settingBefore = JSON.parse(readFileSync(path.join(opened.projectRoot, '.nimbalyst', 'local-wiki.json'), 'utf8'));

    // Home does not read back: imported, but not verified.
    const failingRead = async (name: string, args: Record<string, unknown>) => {
      if (name === 'readCollabDoc') throw new PagesToolError(ExitCode.NOT_FOUND, 'readCollabDoc: not found', 'not_found');
      return server.call(name, args);
    };
    const unverified = await moveLocalWikiToTeam(opened, {}, { call: failingRead, ...noWait });
    expect(unverified.verified).toBe(false);
    expect(readMigratedTo(opened.projectRoot)).toBeUndefined();
    expect((await opened.wiki.readBody(homeId)).markdown).not.toContain('moved to the team project');

    const verified = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait, clock: () => new Date('2026-10-13T00:00:00Z') });
    expect(verified).toMatchObject({ verified: true, bannerWritten: true });
    expect(readMigratedTo(opened.projectRoot)).toEqual({ ...PROJECT, at: '2026-10-13T00:00:00.000Z' });
    const setting = JSON.parse(readFileSync(path.join(opened.projectRoot, '.nimbalyst', 'local-wiki.json'), 'utf8'));
    expect(setting.location).toBe(settingBefore.location);
    expect((await opened.wiki.readBody(homeId)).markdown.split('\n')[0]).toBe(`This wiki moved to the team project: ${HOME_LINK.replace(/home$/, 'home:proj_1')}`);

    // A re-run sends Home without the banner and does not stack a second one.
    await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });
    expect(server.pages.get(homeId).body).not.toContain('moved to the team project');
    expect((await opened.wiki.readBody(homeId)).markdown.match(/moved to the team project/g)).toHaveLength(1);
  });

  it('resumes after a partial failure: the re-run updates instead of duplicating and then verifies', async () => {
    const opened = await makeWiki();
    const a = (await opened.wiki.command({ type: 'register-document', title: 'A', parentFolderId: null, body: 'a\n' })).id!;
    await opened.wiki.command({ type: 'register-document', title: 'B', parentFolderId: a, body: 'b\n' });
    const server = fakeServer();
    server.failOnce.add(a);

    const first = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });
    expect(first).toMatchObject({ verified: false, errors: [expect.objectContaining({ localId: a, title: 'A', code: 'internal' })] });
    expect(readMigratedTo(opened.projectRoot)).toBeUndefined();

    const second = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });
    expect(second).toMatchObject({ verified: true, created: 1, updated: 2, errors: [] });
    expect(server.pages.size).toBe(3);
    const wikiIds = new Set(server.calls.filter((c) => c.name === 'pages_import').map((c) => c.args.source.wikiId));
    expect(wikiIds.size).toBe(1);
    expect(readMigratedTo(opened.projectRoot)).toMatchObject(PROJECT);
  });

  it('sends types with the first batch, typed pages with their fields, table rows as typed pages, and skips editor pages', async () => {
    const opened = await makeWiki();
    const trackers = path.join(opened.projectRoot, '.nimbalyst', 'trackers');
    mkdirSync(trackers, { recursive: true });
    writeFileSync(path.join(trackers, 'competitor.yaml'), 'type: competitor\ndisplayName: Competitor\ndisplayNamePlural: Competitors\nstorage: pages\nfields:\n  - name: title\n    type: string\n  - name: tier\n    type: select\n');
    writeFileSync(path.join(trackers, 'partner.yaml'), 'type: partner\ndisplayName: Partner\ndisplayNamePlural: Partners\nstorage: table\nfields:\n  - name: title\n    type: string\n');
    await opened.wiki.rescan();
    const ops = (await opened.wiki.command({ type: 'register-document', title: 'Ops', parentFolderId: null, body: '' })).id!;
    const acme = (await opened.wiki.trackerCommand('competitor', { type: 'create-item', item: { title: 'Acme', fields: { tier: 'gold' }, parentId: ops, body: 'Decided: ship it.\n' } })).id!;
    await opened.wiki.command({ type: 'set-type-placement', typeId: 'partner', parentFolderId: ops, sortOrder: 500 });
    const row = (await opened.wiki.trackerCommand('partner', { type: 'create-item', item: { title: 'Globex' } })).id!;
    const flow = (await opened.wiki.command({ type: 'register-document', title: 'Flow', parentFolderId: ops, documentType: 'excalidraw', body: '{}' })).id!;
    await opened.wiki.command({ type: 'register-document', title: 'Under flow', parentFolderId: flow, body: 'x\n' });
    const server = fakeServer();

    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });

    const first = server.calls.find((c) => c.name === 'pages_import')!.args;
    expect(first.types.map((t: any) => [t.id, t.name, t.definition.storage])).toEqual([['competitor', 'Competitor', 'pages'], ['partner', 'Partner', 'table']]);
    expect(server.pages.get(acme)).toMatchObject({ kind: 'typedPage', typeId: 'competitor', parentLocalId: ops, fields: { tier: 'gold' }, body: 'Decided: ship it.\n' });
    // A table row sits under its type, which is placed where the table is.
    expect(server.pages.get(row)).toMatchObject({ kind: 'typedPage', typeId: 'partner', parentLocalId: ops, underType: true, title: 'Globex', body: '' });
    expect(server.pages.get(acme).underType).toBeUndefined();
    expect([...server.typePlacements.values()]).toEqual([
      { typeId: 'competitor', parentLocalId: null },
      { typeId: 'partner', parentLocalId: ops, order: 500 },
    ]);
    // Placed only once every page has been sent, so each parent exists.
    const placing = server.calls.findIndex((c) => c.name === 'pages_import' && c.args.typePlacements);
    const lastFirstPass = server.calls.findLastIndex((c) => c.name === 'pages_import' && c.args.pages.some((p: any) => p.localId === row));
    expect(placing).toBeGreaterThan(lastFirstPass);
    expect(server.pages.has(flow)).toBe(false);
    // The editor page's child moves up to the nearest imported page.
    expect([...server.pages.values()].find((p) => p.title === 'Under flow')).toMatchObject({ parentLocalId: ops });
    expect(report).toMatchObject({ verified: true, counts: { pages: 3, typedPages: 2, types: 2, skipped: 1 }, skipped: [{ title: 'Flow' }] });
  });

  it('moves editor pages and linked images: registers each, writes its content, uploads the file and rewrites links to both', async () => {
    const opened = await makeWiki();
    const flow = (await opened.wiki.command({ type: 'register-document', title: 'Flow', parentFolderId: null, documentType: 'excalidraw', body: '{"elements":[]}' })).id!;
    await opened.wiki.command({ type: 'register-document', title: 'Under flow', parentFolderId: flow, body: 'x\n' });
    const notes = (await opened.wiki.command({
      type: 'register-document',
      title: 'Notes',
      parentFolderId: null,
      body: `See [the flow](Flow.excalidraw "id=${flow}"), [again](Flow.excalidraw), ![chart](Notes/.assets/chart.png) and ![gone](Notes/.assets/gone.png).\n`,
    })).id!;
    mkdirSync(path.join(opened.dir, 'Notes', '.assets'), { recursive: true });
    writeFileSync(path.join(opened.dir, 'Notes', '.assets', 'chart.png'), 'png-bytes');
    // Cards by the desktop's path rule: `./` from the canvas, otherwise from the project root.
    const wikiPrefix = path.relative(opened.projectRoot, opened.dir).split(path.sep).join('/');
    const canvasText = JSON.stringify({
      nodes: [
        { id: 'a', type: 'file', file: './Notes.md', x: 0, y: 0, width: 10, height: 10 },
        { id: 'b', type: 'file', file: `${wikiPrefix}/Flow.excalidraw`, x: 0, y: 0, width: 10, height: 10 },
        { id: 'c', type: 'file', file: 'elsewhere/readme.md', x: 0, y: 0, width: 10, height: 10 },
        { id: 'd', type: 'file', file: path.join(opened.dir, 'Notes.md'), x: 0, y: 0, width: 10, height: 10 },
        { id: 'e', type: 'file', file: `file://${path.join(opened.dir, 'Flow.excalidraw')}`, x: 0, y: 0, width: 10, height: 10 },
      ],
    });
    const board = (await opened.wiki.command({ type: 'register-document', title: 'Board', parentFolderId: null, documentType: 'canvas', body: canvasText })).id!;
    const server = fakeServer();
    const written: Array<{ documentId: string; documentType: string; text: string }> = [];
    const uploaded: Array<{ documentId: string; abs: string }> = [];
    const content = {
      writeEditorPage: async (page: { localId: string; documentId: string; documentType: string; text: string }) => {
        written.push({ documentId: page.documentId, documentType: page.documentType, text: page.text });
        return { ok: true as const, outcome: 'seeded' as const };
      },
      uploadFile: async (file: { documentId: string; abs: string }) => {
        uploaded.push(file);
        return { ok: true as const, uri: `collab-asset://doc/${file.documentId}/asset/a1` };
      },
    };
    const loadEditorModels = async () => ({ editorCodecs: { documentTypes: ['excalidraw', 'canvas'] } }) as never;

    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait, loadEditorModels, content });

    const boardWrite = written.find((w) => w.documentType === 'canvas')!;
    expect(boardWrite.documentId).toBe(`t-${board}`);
    expect(JSON.parse(boardWrite.text).nodes.map((n: any) => n['x-nimbalyst']?.reference)).toEqual([
      { kind: 'file', path: './Notes.md', sharedAs: { uri: `nimbalyst://doc/org_1/t-${notes}` } },
      { kind: 'file', path: `${wikiPrefix}/Flow.excalidraw`, sharedAs: { uri: `nimbalyst://doc/org_1/t-${flow}` } },
      undefined,
      { kind: 'file', path: path.join(opened.dir, 'Notes.md'), sharedAs: { uri: `nimbalyst://doc/org_1/t-${notes}` } },
      { kind: 'file', path: `file://${path.join(opened.dir, 'Flow.excalidraw')}`, sharedAs: { uri: `nimbalyst://doc/org_1/t-${flow}` } },
    ]);
    written.splice(written.indexOf(boardWrite), 1);
    const link = (id: string) => `https://console.nimbalyst.com/org/org_1/project/proj_1/document/t-${id}`;
    expect(server.pages.get(flow)).toMatchObject({ kind: 'editorPage', documentType: 'excalidraw', fileExtension: '.excalidraw', editorId: 'com.nimbalyst.excalidraw', body: '' });
    // Its child stays under it now that it moves.
    expect([...server.pages.values()].find((p) => p.title === 'Under flow')).toMatchObject({ parentLocalId: flow });
    expect(written).toEqual([{ documentId: `t-${flow}`, documentType: 'excalidraw', text: '{"elements":[]}' }]);
    expect(uploaded).toEqual([{ documentId: `t-${notes}`, abs: path.join(opened.dir, 'Notes', '.assets', 'chart.png') }]);
    expect(server.pages.get(notes).body).toBe(
      `See [the flow](${link(flow)}), [again](${link(flow)}), ![chart](collab-asset://doc/t-${notes}/asset/a1) and ![gone](Notes/.assets/gone.png).\n`,
    );
    // A missing image is left as written without holding the move back.
    expect(report).toMatchObject({
      verified: true,
      counts: { pages: 3, editorPages: 2, files: 1, skipped: 0 },
      editorPagesWritten: 2,
      filesUploaded: 1,
      warnings: [expect.objectContaining({ localId: notes, code: 'linked_file_missing', title: 'Notes' })],
    });
  });

  it('keeps embeds as team embeds and points links inside HTML pages at their team pages', async () => {
    const opened = await makeWiki();
    const flow = (await opened.wiki.command({ type: 'register-document', title: 'Flow', parentFolderId: null, documentType: 'excalidraw', body: '{"elements":[]}' })).id!;
    const notes = (await opened.wiki.command({ type: 'register-document', title: 'Notes', parentFolderId: null, body: 'n\n' })).id!;
    const map = (await opened.wiki.command({
      type: 'register-document',
      title: 'Map',
      parentFolderId: null,
      documentType: 'html',
      body: '<a href="Notes.md#top">Notes</a> <a class="box" href=\'./Flow.excalidraw\'>Flow</a> <a href="https://example.com">web</a> <a href="#local">here</a> <a href="Gone.md">gone</a>',
    })).id!;
    const overview = (await opened.wiki.command({
      type: 'register-document',
      title: 'Overview',
      parentFolderId: null,
      body: `[Flow](Flow.excalidraw "width=800 height=400")\n\n  [Map](Map.html "id=${map}")\n\nInline [flow](Flow.excalidraw) stays a link.\n\n[Not embedded](Flow.excalidraw "embed=false")\n`,
    })).id!;
    const server = fakeServer();
    const written = new Map<string, string>();
    const content = {
      writeEditorPage: async (page: { documentId: string; text: string }) => (written.set(page.documentId, page.text), { ok: true as const, outcome: 'seeded' as const }),
      uploadFile: async () => ({ ok: false as const, code: 'unused', message: 'unused' }),
    };
    const loadEditorModels = async () => ({ editorCodecs: { documentTypes: ['excalidraw', 'html'] } }) as never;

    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait, loadEditorModels, content });

    const link = (id: string) => `https://console.nimbalyst.com/org/org_1/project/proj_1/document/t-${id}`;
    const doc = (id: string) => `nimbalyst://doc/t-${id}?orgId=org_1`;
    expect(server.pages.get(overview).body).toBe(
      `[Flow](${doc(flow)} "width=800 height=400 embedType=.excalidraw")\n\n  [Map](${doc(map)} "embedType=.html")\n\n` +
        `Inline [flow](${link(flow)}) stays a link.\n\n[Not embedded](${link(flow)} "embed=false")\n`,
    );
    expect(written.get(`t-${map}`)).toBe(
      `<a href="${link(notes)}#top">Notes</a> <a class="box" href='${link(flow)}'>Flow</a> <a href="https://example.com">web</a> <a href="#local">here</a> <a href="Gone.md">gone</a>`,
    );
    expect(report).toMatchObject({ verified: true, editorPagesWritten: 2 });
  });

  it("uploads a typed page's images into its body document, and writes nothing into a page the server refused as another type", async () => {
    const opened = await makeWiki();
    const trackers = path.join(opened.projectRoot, '.nimbalyst', 'trackers');
    mkdirSync(trackers, { recursive: true });
    writeFileSync(path.join(trackers, 'competitor.yaml'), 'type: competitor\ndisplayName: Competitor\ndisplayNamePlural: Competitors\nstorage: pages\nfields:\n  - name: title\n    type: string\n');
    await opened.wiki.rescan();
    const acme = (await opened.wiki.trackerCommand('competitor', { type: 'create-item', item: { title: 'Acme', body: '![logo](Acme/.assets/logo.png)\n' } })).id!;
    const acmePage = (await opened.wiki.snapshot()).pages.find((page) => page.id === acme)!;
    mkdirSync(path.join(opened.dir, acmePage.dir, '.assets'), { recursive: true });
    writeFileSync(path.join(opened.dir, acmePage.dir, '.assets', 'logo.png'), 'png');
    const flow = (await opened.wiki.command({ type: 'register-document', title: 'Flow', parentFolderId: null, documentType: 'excalidraw', body: '{}' })).id!;
    const server = fakeServer();
    server.typeMismatch.add(flow);
    const written: string[] = [];
    const uploads: string[] = [];
    const content = {
      writeEditorPage: async (page: { documentId: string }) => (written.push(page.documentId), { ok: true as const, outcome: 'seeded' as const }),
      uploadFile: async (file: { documentId: string }) => (uploads.push(file.documentId), { ok: true as const, uri: `collab-asset://doc/${encodeURIComponent(file.documentId)}/asset/a1` }),
    };
    const loadEditorModels = async () => ({ editorCodecs: { documentTypes: ['excalidraw'] } }) as never;

    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait, loadEditorModels, content });

    expect(uploads).toEqual([`tracker-content/t-${acme}`]);
    expect(server.pages.get(acme).body).toBe(`![logo](collab-asset://doc/tracker-content%2Ft-${acme}/asset/a1)\n`);
    expect(written).toEqual([]);
    expect(report).toMatchObject({ verified: false, errors: [expect.objectContaining({ localId: flow, code: 'document_type_mismatch' })] });
  });

  it('leaves an editor page someone edited in the team, reporting body_edited, and does not mark the wiki moved', async () => {
    const opened = await makeWiki();
    const flow = (await opened.wiki.command({ type: 'register-document', title: 'Flow', parentFolderId: null, documentType: 'excalidraw', body: '{}' })).id!;
    const server = fakeServer();
    const content = {
      writeEditorPage: async () => ({ ok: false as const, code: 'body_edited', message: 'edited in the team' }),
      uploadFile: async () => ({ ok: false as const, code: 'unused', message: 'unused' }),
    };
    const loadEditorModels = async () => ({ editorCodecs: { documentTypes: ['excalidraw'] } }) as never;

    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait, loadEditorModels, content });

    expect(report).toMatchObject({ verified: false, errors: [expect.objectContaining({ localId: flow, title: 'Flow', code: 'body_edited' })] });
    expect(readMigratedTo(opened.projectRoot)).toBeUndefined();
  });

  it("lists editor pages as not moved, with the loader's reason, when the editors' document code is missing", async () => {
    const opened = await makeWiki();
    await opened.wiki.command({ type: 'register-document', title: 'Flow', parentFolderId: null, documentType: 'excalidraw', body: '{}' });
    const loadEditorModels = async () => {
      throw new Error('install @nimbalyst/wiki-web');
    };

    const report = await moveLocalWikiToTeam(opened, { dryRun: true }, { call: fakeServer().call, ...noWait, loadEditorModels });

    expect(report).toMatchObject({ counts: { editorPages: 0, skipped: 1 }, skipped: [{ title: 'Flow', reason: 'excalidraw page (install @nimbalyst/wiki-web)' }] });
  });

  it('keeps every request under 900 KB and reports a page too large for any request as an error for that page', async () => {
    const opened = await makeWiki();
    const big = 'y'.repeat(200_000);
    for (let i = 0; i < 9; i++) writeFileSync(path.join(opened.dir, `Big ${i}.md`), `---\nid: big${i}\n---\n${big}\n`);
    writeFileSync(path.join(opened.dir, 'Huge.md'), `---\nid: huge\n---\n${'z'.repeat(950_000)}\n`);
    await opened.wiki.rescan();
    const server = fakeServer();

    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });

    const imports = server.calls.filter((c) => c.name === 'pages_import');
    for (const c of imports) {
      const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pages_import', arguments: c.args } };
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(900_000);
    }
    expect(imports.length).toBeGreaterThanOrEqual(3);
    expect(server.pages.has('huge')).toBe(false);
    expect(server.pages.size).toBe(10);
    expect(report).toMatchObject({ verified: false, errors: [expect.objectContaining({ localId: 'huge', title: 'Huge', code: 'page_too_large' })] });
    expect(readMigratedTo(opened.projectRoot)).toBeUndefined();
  });

  it('does not send the descendants of a page that was not imported, reporting each as parent_not_imported', async () => {
    const opened = await makeWiki();
    const put = (rel: string, id: string, order: number, body = 'x') => {
      mkdirSync(path.dirname(path.join(opened.dir, rel)), { recursive: true });
      writeFileSync(path.join(opened.dir, rel), `---\nid: ${id}\norder: ${order}\n---\n${body}\n`);
    };
    // 48 fillers so that Failed is the 50th page of the first request and its subtree lands in the second.
    for (let i = 0; i < 48; i++) put(`Filler ${i}.md`, `f${i}`, 2000 + i);
    put('Failed.md', 'failed', 100_000);
    put('Failed/Child.md', 'fchild', 1000);
    put('Failed/Child/Grandchild.md', 'fgrand', 1000);
    put('Huge.md', 'huge', 200_000, 'z'.repeat(950_000));
    put('Huge/Under.md', 'hchild', 1000);
    put('Huge/Under/Deeper.md', 'hgrand', 1000);
    await opened.wiki.rescan();
    const server = fakeServer();
    server.failOnce.add('failed');

    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });

    const imports = server.calls.filter((c) => c.name === 'pages_import');
    expect(imports[0].args.pages.at(-1).localId).toBe('failed');
    const sent = new Set(imports.flatMap((c) => c.args.pages.map((p: any) => p.localId)));
    for (const id of ['fchild', 'fgrand', 'huge', 'hchild', 'hgrand']) expect(sent.has(id), id).toBe(false);
    const codes = Object.fromEntries((report.errors ?? []).map((e) => [e.localId, e.code]));
    expect(codes).toEqual({
      failed: 'internal',
      fchild: 'parent_not_imported',
      fgrand: 'parent_not_imported',
      huge: 'page_too_large',
      hchild: 'parent_not_imported',
      hgrand: 'parent_not_imported',
    });
    expect(report.verified).toBe(false);
    expect(readMigratedTo(opened.projectRoot)).toBeUndefined();
  });

  it('sends relationship fields only after every page has its team id, remapped, and reports a target that was not imported', async () => {
    const opened = await makeWiki();
    const trackers = path.join(opened.projectRoot, '.nimbalyst', 'trackers');
    mkdirSync(trackers, { recursive: true });
    writeFileSync(
      path.join(trackers, 'service.yaml'),
      'type: service\ndisplayName: Service\ndisplayNamePlural: Services\nstorage: pages\nfields:\n  - name: title\n    type: string\n  - name: tier\n    type: select\n  - name: dependsOn\n    type: relationship\n    multiValue: true\n  - name: owner\n    type: relationship\n',
    );
    const put = (rel: string, text: string) => writeFileSync(path.join(opened.dir, rel), text);
    // A and B point at each other (a cycle); C points at an item that is not in the wiki.
    put('A.md', '---\nid: svcA\ntype: service\norder: 2000\ntier: gold\ndependsOn: [svcB]\nowner: svcB\n---\na\n');
    put('B.md', '---\nid: svcB\ntype: service\norder: 3000\ndependsOn: [svcA]\n---\nb\n');
    put('C.md', '---\nid: svcC\ntype: service\norder: 4000\nowner: ghost\n---\nc\n');
    await opened.wiki.rescan();
    const server = fakeServer();

    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });

    const [first, ...rest] = server.calls.filter((c) => c.name === 'pages_import' && c.args.pages.length);
    for (const page of first.args.pages) {
      expect(page.fields?.dependsOn, page.localId).toBeUndefined();
      expect(page.fields?.owner, page.localId).toBeUndefined();
    }
    expect(first.args.pages.find((p: any) => p.localId === 'svcA').fields).toEqual({ tier: 'gold' });
    expect(rest.length).toBeGreaterThan(0);
    expect(server.pages.get('svcA').fields).toEqual({ tier: 'gold', dependsOn: ['t-svcB'], owner: 't-svcB' });
    expect(server.pages.get('svcB').fields).toEqual({ dependsOn: ['t-svcA'] });
    expect(server.pages.get('svcC').fields?.owner).toBeUndefined();
    expect(report.errors).toEqual([expect.objectContaining({ localId: 'svcC', code: 'relationship_target_not_imported' })]);
    expect(report.verified).toBe(false);
  });

  it('sends types on their own, at most 20 per call, before any page, and reports a type too large to send', async () => {
    const opened = await makeWiki();
    const trackers = path.join(opened.projectRoot, '.nimbalyst', 'trackers');
    mkdirSync(trackers, { recursive: true });
    for (let i = 0; i < 25; i++) {
      writeFileSync(path.join(trackers, `t${i}.yaml`), `type: t${i}\ndisplayName: T${i}\ndisplayNamePlural: T${i}s\nstorage: pages\nfields:\n  - name: title\n    type: string\n`);
    }
    writeFileSync(path.join(trackers, 'huge.yaml'), `type: huge\ndisplayName: Huge\ndisplayNamePlural: Huges\nstorage: pages\ndescription: ${'q'.repeat(950_000)}\nfields:\n  - name: title\n    type: string\n`);
    await opened.wiki.rescan();
    const server = fakeServer();

    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });

    const imports = server.calls.filter((c) => c.name === 'pages_import');
    const typeCalls = imports.filter((c) => c.args.types);
    expect(typeCalls.map((c) => [c.args.types.length, c.args.pages.length])).toEqual([[20, 0], [5, 0]]);
    // Types go first; no page request carries types.
    expect(imports.slice(0, 2)).toEqual(typeCalls);
    for (const c of imports) {
      const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pages_import', arguments: c.args } };
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(900_000);
    }
    expect(report.errors).toEqual([expect.objectContaining({ localId: 'type:huge', code: 'type_too_large' })]);
    expect(report.verified).toBe(false);
  });

  it("moves the local Home into the project's Home page, named in every batch, and banners its link", async () => {
    const opened = await makeWiki();
    const homeId = (await opened.wiki.snapshot()).pages.find((p) => p.title === 'Home')!.id;
    await opened.wiki.command({ type: 'register-document', title: 'Overview', parentFolderId: null, body: 'o\n' });
    const server = fakeServer();
    const report = await moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });
    const imports = server.calls.filter((c) => c.name === 'pages_import');
    expect(imports.length).toBeGreaterThan(0);
    for (const c of imports) expect(c.args.homeLocalId).toBe(homeId);
    const imported = 'https://console.nimbalyst.com/org/org_1/project/proj_1/document/home:proj_1';
    expect(report.homeLink).toBe(imported);
    expect((await opened.wiki.readBody(homeId)).markdown.split('\n')[0]).toBe(`This wiki moved to the team project: ${imported}`);
  });

  it('dry run reads the wiki and checks the target without importing', async () => {
    const opened = await makeWiki();
    const server = fakeServer();
    const report = await moveLocalWikiToTeam(opened, { dryRun: true }, { call: server.call, ...noWait });
    expect(report).toMatchObject({ dryRun: true, counts: { pages: 1 }, project: { ...PROJECT, projectName: 'Acme' }, homeLink: HOME_LINK });
    expect(server.calls.map((c) => c.name)).toEqual(['pages_status']);
  });
});
