// @vitest-environment node
/**
 * Publishing a real local wiki to a team project against a fake server that
 * upserts on localId, refuses a body edited on the team side (`body_edited`)
 * and keeps a Trash: `export: false` pages and person fields stay out, a
 * republish counts unchanged pages, a page deleted locally goes to team Trash
 * only when the team copy is still what the publish wrote, and nothing is
 * removed after an unverified publish.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { readPublishTarget, writeMigratedTo, writePublishTarget } from '../locate.js';
import { initLocalWiki, openLocalWiki, type OpenedWiki } from '../open.js';
import { publishManifestPath } from '../publishManifest.js';
import { initPublish, publishLocalWikiToTeam, PUBLISH_NOTE_PREFIX } from '../publishToTeam.js';
import { moveLocalWikiToTeam } from '../moveToTeam.js';
import { diffPublishedPage, listPublishedComments } from '../publishedComments.js';

const dirs: string[] = [];
const wikis: OpenedWiki[] = [];
afterEach(() => {
  for (const opened of wikis.splice(0)) opened.wiki.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROJECT = { orgId: 'org_1', projectId: 'proj_1' };

async function makeWiki(): Promise<OpenedWiki> {
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-publish-')));
  dirs.push(project);
  mkdirSync(path.join(project, '.nimbalyst'), { recursive: true });
  writeFileSync(path.join(project, '.nimbalyst', 'wiki.json'), JSON.stringify(PROJECT));
  (await initLocalWiki(project)).wiki.close();
  const opened = await openLocalWiki(project);
  wikis.push(opened);
  return opened;
}

interface TeamPage {
  localId: string;
  title: string;
  body: string;
  fields?: Record<string, unknown>;
  /** What the server last wrote; a body that differs was edited on the team side. */
  written: string;
  trashed?: boolean;
  archived?: boolean;
  /** Times the body was replaced (each drops the page's comment marks). */
  writes: number;
}

function fakeServer(options: { bound?: boolean; status?: () => any } = {}) {
  const pages = new Map<string, TeamPage>();
  const byTeamId = (id: string) => [...pages.values()].find((page) => teamId(page.localId) === id);
  const teamId = (localId: string) => `t-${localId}`;
  const calls: Array<{ name: string; args: any }> = [];
  const server = {
    pages,
    calls,
    bound: options.bound ?? true,
    /** Pages whose body cannot be read back. */
    unreadable: new Set<string>(),
    /** Someone edits the page in the team. */
    editInTeam(localId: string, body: string) {
      pages.get(localId)!.body = body;
    },
    call: async (name: string, args: any): Promise<any> => {
      calls.push({ name, args: structuredClone(args) });
      switch (name) {
        case 'pages_status':
          if (options.status) return options.status();
          return server.bound
            ? { state: 'bound', project: { ...PROJECT, projectName: 'Acme' }, homeLink: 'https://console/home' }
            : { state: 'unbound', teams: [{ orgId: 'org_1', role: 'admin' }] };
        case 'pages_create_project':
          server.bound = true;
          return { project: { ...PROJECT, projectName: args.name } };
        case 'pages_import': {
          const idMap: Record<string, unknown> = {};
          const errors: unknown[] = [];
          let created = 0;
          let updated = 0;
          for (const page of args.pages) {
            const id = teamId(page.localId);
            idMap[page.localId] = { nodeId: `${page.kind === 'typedPage' ? 'item' : 'document'}:${id}`, id, link: `https://console/${id}`, uri: `collab://${id}` };
            const current = pages.get(page.localId);
            if (current && !current.trashed) {
              // Edited in the team: refused, unless asked to write exactly what is there, which records it as the server's (slice B).
              if (current.body !== current.written && page.body !== current.body) {
                errors.push({ localId: page.localId, code: 'body_edited', message: 'edited' });
                continue;
              }
              if (page.body !== current.body) current.writes++;
              Object.assign(current, { title: page.title, body: page.body, written: page.body, fields: page.fields });
              updated++;
            } else {
              pages.set(page.localId, { localId: page.localId, title: page.title, body: page.body, written: page.body, fields: page.fields, writes: 1 });
              created++;
            }
          }
          return { idMap, created, updated, errors };
        }
        case 'readCollabDoc': {
          const page = byTeamId(String(args.filePath).replace('collab://', ''));
          if (!page || page.trashed || server.unreadable.has(page.localId)) throw new Error('not found');
          return { markdown: page.body };
        }
        case 'deleteSharedItem': {
          const page = byTeamId(args.itemId);
          if (!page) throw new Error('No page');
          page.trashed = true;
          return { trashed: true };
        }
        case 'tracker_update': {
          byTeamId(args.id)!.archived = args.archived;
          return { ok: true };
        }
        default:
          throw new Error(`unexpected ${name}`);
      }
    },
  };
  return server;
}

const noWait = { sleep: async () => {}, minIntervalMs: 0 };

/** A Lexical root holding one paragraph of `text`, in the item-list shape a room's untyped top-level type has. */
const block = (text: string) => ({
  _start: { deleted: false, right: null, content: { type: { getAttribute: () => 'paragraph', _start: { deleted: false, right: null, content: { str: text } } } } },
});

describe('publishLocalWikiToTeam', () => {
  it('compares published editor embeds in the same form as publish without loading codecs', async () => {
    const opened = await makeWiki();
    writePublishTarget(opened.projectRoot, PROJECT);
    const flow = (await opened.wiki.command({ type: 'register-document', title: 'Flow', parentFolderId: null, documentType: 'excalidraw', body: '{"elements":[]}' })).id!;
    const notes = (await opened.wiki.command({
      type: 'register-document', title: 'Notes', parentFolderId: null,
      body: `[Flow](Flow.excalidraw "id=${flow}")\n\n[Flow by path](Flow.excalidraw)\n`,
    })).id!;
    const server = fakeServer();
    const content = {
      writeEditorPage: async () => ({ ok: true as const, outcome: 'seeded' as const }),
      uploadFile: async () => ({ ok: true as const, uri: 'unused' }),
    };
    const deps = { call: server.call, ...noWait };
    const published = await publishLocalWikiToTeam(opened, {}, {
      ...deps, content, loadEditorModels: async () => ({ editorCodecs: { documentTypes: ['excalidraw'] } }) as any,
    });
    expect(published.verified).toBe(true);
    expect(server.pages.get(notes)!.body).toContain('embedType=.excalidraw');
    // The diff command does not load the editor-models bundle. Published page
    // metadata must suffice to reproduce both id-based and path-based embeds.
    expect(await diffPublishedPage(opened, notes, deps)).toMatchObject({ identical: true, diff: '' });
  });

  it('publishes, counts unchanged pages, and trashes a page deleted locally unless it was edited in the team', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const plan = (await wiki.command({ type: 'register-document', title: 'Plan', parentFolderId: null, body: 'The plan.\n' })).id!;
    const old = (await wiki.command({ type: 'register-document', title: 'Old', parentFolderId: null, body: 'Old page.\n' })).id!;
    const edited = (await wiki.command({ type: 'register-document', title: 'Edited', parentFolderId: null, body: 'Mine.\n' })).id!;
    const server = fakeServer();
    const deps = { call: server.call, ...noWait };

    const first = await publishLocalWikiToTeam(opened, {}, deps);
    expect(first).toMatchObject({ verified: true, created: 4, updated: 0, unchanged: 0, removals: [] });
    expect(existsSync(publishManifestPath(opened.projectRoot))).toBe(true);
    expect(readPublishTarget(opened.projectRoot)?.publishedAt).toBeTruthy();

    const second = await publishLocalWikiToTeam(opened, {}, deps);
    expect(second).toMatchObject({ verified: true, created: 0, updated: 0, unchanged: 4 });

    // Deleted locally: one untouched in the team, one a reviewer edited there.
    server.editInTeam(edited, 'Theirs.\n');
    await wiki.command({ type: 'trash-document', documentId: old });
    await wiki.command({ type: 'trash-document', documentId: edited });
    await wiki.writeBody(plan, 'The new plan.\n', (await wiki.readBody(plan)).version);

    const third = await publishLocalWikiToTeam(opened, {}, deps);
    expect(third).toMatchObject({ verified: true, updated: 1, unchanged: 1 });
    expect(third.removals).toEqual(expect.arrayContaining([
      expect.objectContaining({ localId: old, action: 'trashed' }),
      expect.objectContaining({ localId: edited, action: 'kept', reason: expect.stringMatching(/edited it in the team/) }),
    ]));
    expect(server.pages.get(old)!.trashed).toBe(true);
    expect(server.pages.get(edited)!.trashed).toBeUndefined();
    expect(server.pages.get(plan)!.body).toBe('The new plan.\n');
    // The page left in place stays in the record, so the next publish reports it again.
    const manifest = JSON.parse(readFileSync(publishManifestPath(opened.projectRoot), 'utf8'));
    expect(manifest.pages[edited]).toMatchObject({ removedLocally: true });
    expect(manifest.pages[old]).toBeUndefined();
  });

  it('republishes only what changed: nothing for an unchanged wiki, the edited page, and a page linking to a new one', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await wiki.command({ type: 'register-document', title: `Page ${i}`, parentFolderId: null, body: `Text ${i}.\n` })).id!);
    const server = fakeServer();
    const deps = { call: server.call, ...noWait };
    const sentPages = () => server.calls.splice(0).filter((c) => c.name === 'pages_import').flatMap((c) => c.args.pages.map((page: any) => page.localId));

    expect((await publishLocalWikiToTeam(opened, {}, deps)).verified).toBe(true);
    expect(sentPages().length).toBeGreaterThanOrEqual(7);

    expect(await publishLocalWikiToTeam(opened, {}, deps)).toMatchObject({ verified: true, updated: 0, unchanged: 7 });
    expect(sentPages()).toEqual([]);

    await wiki.writeBody(ids[2], 'Text 2, revised.\n', (await wiki.readBody(ids[2])).version);
    expect(await publishLocalWikiToTeam(opened, {}, deps)).toMatchObject({ verified: true, updated: 1, unchanged: 6 });
    expect(sentPages()).toEqual([ids[2]]);
    expect(server.pages.get(ids[2])!.body).toBe('Text 2, revised.\n');

    // A new page, and an unchanged page whose link to it now resolves to the team page.
    const added = (await wiki.command({ type: 'register-document', title: 'Added', parentFolderId: null, body: 'New.\n' })).id!;
    await wiki.writeBody(ids[4], 'See [Added](Added.md).\n', (await wiki.readBody(ids[4])).version);
    expect((await publishLocalWikiToTeam(opened, {}, deps)).verified).toBe(true);
    expect(server.pages.get(ids[4])!.body).toContain(`https://console/t-${added}`);
    server.calls.splice(0);
    // Unchanged since: the linking page is not sent again.
    expect((await publishLocalWikiToTeam(opened, {}, deps)).verified).toBe(true);
    expect(sentPages()).toEqual([]);
  });

  it('leaves out export: false pages and person fields, and says on the team Home where the pages come from', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const draft = (await wiki.command({ type: 'register-document', title: 'Draft', parentFolderId: null, body: 'Private.\n' })).id!;
    const under = (await wiki.command({ type: 'register-document', title: 'Under', parentFolderId: draft, body: 'Also private.\n' })).id!;
    const spec = (await wiki.command({ type: 'register-document', title: 'Spec', parentFolderId: null, body: 'Public.\n' })).id!;
    await wiki.command({ type: 'set-document-fields', documentId: draft, fields: { export: false } });
    await wiki.command({ type: 'set-document-fields', documentId: spec, fields: { owner: 'Ana', reviewer: 'ana@example.com', status: 'draft' } });
    const server = fakeServer();

    const report = await publishLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });

    expect(report.verified).toBe(true);
    expect(server.pages.has(draft)).toBe(false);
    expect(server.pages.has(under)).toBe(false);
    expect(report.skipped.map((s) => s.title).sort()).toEqual(['Draft', 'Under']);
    expect(server.pages.get(spec)!.fields).toEqual({ status: 'draft' });
    expect(report.counts.strippedFields).toBe(2);
    const home = [...server.pages.values()].find((page) => page.title === 'Home')!;
    expect(home.body.startsWith(PUBLISH_NOTE_PREFIX)).toBe(true);
    // The local Home is not touched.
    const localHome = (await wiki.snapshot()).pages.find((page) => page.title === 'Home')!;
    expect((await wiki.readBody(localHome.id)).markdown).not.toContain(PUBLISH_NOTE_PREFIX);

    // Marking a published page export: false takes its team copy out on the next publish.
    await wiki.command({ type: 'set-document-fields', documentId: spec, fields: { export: false } });
    const next = await publishLocalWikiToTeam(opened, {}, { call: server.call, ...noWait });
    expect(next.removals).toEqual([expect.objectContaining({ localId: spec, action: 'trashed' })]);
  });

  it('sends only the page fields the team stores, publishes type: page as a plain page, and leaves out an editor page too large for a team room', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const covered = (await wiki.command({ type: 'register-document', title: 'Covered', parentFolderId: null, body: 'Code map.\n' })).id!;
    await wiki.command({ type: 'set-document-fields', documentId: covered, fields: { status: 'current', summary: 'Where the code lives', paths: ['src/**'] } });
    const plain = (await wiki.command({ type: 'register-document', title: 'Plain', parentFolderId: null, body: '---\ntype: page\n---\nPlain text.\n' })).id!;
    const huge = (await wiki.command({
      type: 'register-document', title: 'Huge map', parentFolderId: null, documentType: 'excalidraw',
      body: JSON.stringify({ elements: [{ id: 'x', text: 'y'.repeat(1_100_000) }] }),
    })).id!;
    const server = fakeServer();
    const written: string[] = [];
    const content = {
      writeEditorPage: async (page: { documentId: string }) => {
        written.push(page.documentId);
        return { ok: true as const, outcome: 'seeded' as const };
      },
      uploadFile: async () => ({ ok: true as const, uri: 'unused' }),
    };

    const report = await publishLocalWikiToTeam(opened, {}, {
      call: server.call, ...noWait, content, loadEditorModels: async () => ({ editorCodecs: { documentTypes: ['excalidraw'] } }) as any,
    });

    const sent = server.calls.filter((c) => c.name === 'pages_import').flatMap((c) => c.args.pages);
    expect(sent.find((page: any) => page.localId === covered)!.fields).toEqual({ status: 'current', summary: 'Where the code lives' });
    expect(sent.find((page: any) => page.localId === plain)).toMatchObject({ kind: 'page' });
    expect(sent.find((page: any) => page.localId === plain).typeId).toBeUndefined();
    expect(sent.some((page: any) => page.localId === huge)).toBe(false);
    expect(written).toEqual([]);
    expect(report.skipped).toEqual([expect.objectContaining({ title: 'Huge map', reason: expect.stringContaining('MB') })]);
    expect(report.verified).toBe(true);
  });

  it('reports a page edited in the team without failing, and removes nothing after an unverified publish', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const a = (await wiki.command({ type: 'register-document', title: 'A', parentFolderId: null, body: 'a\n' })).id!;
    const b = (await wiki.command({ type: 'register-document', title: 'B', parentFolderId: null, body: 'b\n' })).id!;
    const server = fakeServer();
    const deps = { call: server.call, ...noWait };
    await publishLocalWikiToTeam(opened, {}, deps);

    server.editInTeam(a, 'a, reviewed\n');
    await wiki.writeBody(a, 'a2\n', (await wiki.readBody(a)).version);
    const edited = await publishLocalWikiToTeam(opened, {}, deps);
    expect(edited.verified).toBe(true);
    expect(edited.bodyEdited).toEqual([expect.objectContaining({ localId: a, title: 'A', file: expect.stringMatching(/A\.md$/) })]);
    expect(edited.errors).toEqual([]);

    // A page that fails: B is deleted locally, but the publish is not verified, so B's team copy stays.
    await wiki.command({ type: 'trash-document', documentId: b });
    const failing = { ...deps, call: async (name: string, args: any) => {
      const result = await server.call(name, args);
      if (name === 'pages_import' && args.pages.length) return { ...result, errors: [...result.errors, { localId: args.pages[0].localId, code: 'internal', message: 'boom' }] };
      return result;
    } };
    const unverified = await publishLocalWikiToTeam(opened, {}, failing);
    expect(unverified.verified).toBe(false);
    expect(server.pages.get(b)!.trashed).toBeUndefined();
    expect(server.calls.some((c) => c.name === 'deleteSharedItem')).toBe(false);
  });

  it('keeps a moved or renamed page under the same team id, with nothing removed', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const parent = (await wiki.command({ type: 'register-document', title: 'Parent', parentFolderId: null, body: 'p\n' })).id!;
    const child = (await wiki.command({ type: 'register-document', title: 'Child', parentFolderId: null, body: 'c\n' })).id!;
    const server = fakeServer();
    const deps = { call: server.call, ...noWait };
    await publishLocalWikiToTeam(opened, {}, deps);

    await wiki.command({ type: 'move-document', documentId: child, parentFolderId: parent, sortOrder: 1000 } as any);
    await wiki.command({ type: 'update-document-title', documentId: child, title: 'Renamed' });
    const report = await publishLocalWikiToTeam(opened, {}, deps);

    expect(report).toMatchObject({ verified: true, created: 0, removals: [] });
    const sent = server.calls.filter((c) => c.name === 'pages_import').at(-1)!.args.pages.find((p: any) => p.title === 'Renamed');
    expect(sent).toMatchObject({ localId: child, parentLocalId: parent });
    const manifest = JSON.parse(readFileSync(publishManifestPath(opened.projectRoot), 'utf8'));
    expect(manifest.pages[child]).toMatchObject({ id: `t-${child}`, title: 'Renamed', parentLocalId: parent });
  });

  it('lists open threads whose quote is gone after the publish rewrote their page', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const page = (await wiki.command({ type: 'register-document', title: 'Spec', parentFolderId: null, body: 'Ships in March.\n' })).id!;
    const server = fakeServer();
    const rooms: string[] = [];
    const content = {
      writeEditorPage: async () => ({ ok: true as const, outcome: 'seeded' as const }),
      uploadFile: async () => ({ ok: true as const, uri: 'x' }),
      // A doc whose root says "Ships in April." and whose one thread quotes "in March".
      readRoom: async <T>(documentId: string, read: (doc: unknown) => T) => {
        rooms.push(documentId);
        const text = block('Ships in April.');
        const thread = new Map<string, unknown>([['type', 'thread'], ['id', 'th1'], ['quote', 'in March'], ['resolved', false],
          ['comments', { _start: { deleted: false, right: null, content: { getContent: () => [new Map<string, unknown>([['id', 'c1'], ['content', 'Is March right?'], ['timeStamp', 1], ['author', 'Ana']])] } } }]]);
        const doc = { share: new Map<string, unknown>([['root', text], ['comments', { _start: { deleted: false, right: null, content: { getContent: () => [thread] } } }]]) };
        return { ok: true as const, value: read(doc) };
      },
    };
    const deps = { call: server.call, ...noWait, content, loadEditorModels: async () => ({ editorCodecs: { documentTypes: [] } }) as any };
    await publishLocalWikiToTeam(opened, {}, deps);
    expect(rooms).toEqual([]);

    await wiki.writeBody(page, 'Ships in April.\n', (await wiki.readBody(page)).version);
    const report = await publishLocalWikiToTeam(opened, {}, deps);

    expect(rooms).toEqual([`t-${page}`]);
    expect(report.orphanedThreads).toEqual([expect.objectContaining({ localId: page, threadId: 'th1', quote: 'in March', author: 'Ana', file: expect.stringMatching(/Spec\.md$/) })]);
  });

  it('refuses a moved wiki, and a move refuses a publishing wiki', async () => {
    const opened = await makeWiki();
    writePublishTarget(opened.projectRoot, PROJECT);
    const server = fakeServer();
    await expect(moveLocalWikiToTeam(opened, {}, { call: server.call, ...noWait })).rejects.toThrow(/publishes to team project/);

    const other = await makeWiki();
    writeMigratedTo(other.projectRoot, { ...PROJECT, at: '2026-11-01T00:00:00.000Z' });
    await expect(publishLocalWikiToTeam(other, {}, { call: server.call, ...noWait })).rejects.toThrow(/was moved to team project/);
    await expect(initPublish(other, {}, { call: server.call, ...noWait })).rejects.toThrow(/moved/);
  });

  it('--init creates the project in the one team the user administers, records the target, and publishes', async () => {
    const opened = await makeWiki();
    rmSync(path.join(opened.projectRoot, '.nimbalyst', 'wiki.json'));
    const server = fakeServer({ bound: false });

    const report = await initPublish(opened, { name: 'Acme docs' }, { call: server.call, ...noWait });

    expect(server.calls.find((c) => c.name === 'pages_create_project')!.args).toMatchObject({ orgId: 'org_1', name: 'Acme docs' });
    expect(readPublishTarget(opened.projectRoot)).toMatchObject({ ...PROJECT, publishedAt: expect.any(String) });
    // No origin remote to bind, so the checkout is pinned to the new project.
    expect(JSON.parse(readFileSync(path.join(opened.projectRoot, '.nimbalyst', 'wiki.json'), 'utf8'))).toMatchObject(PROJECT);
    expect(report).toMatchObject({ verified: true, created: 1 });
  });

  it('lists open threads per published page with the local file, and diffs a page edited in the team against its file', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const spec = (await wiki.command({ type: 'register-document', title: 'Spec', parentFolderId: null, body: 'One.\nTwo.\nThree.\n' })).id!;
    const server = fakeServer();
    const list = (values: unknown[]) => ({ _start: values.length ? { deleted: false, right: null, content: { getContent: () => values } } : null });
    const docFor = (documentId: string) => ({
      share: new Map<string, unknown>([
        ['root', block('One. Two. Three.')],
        ['comments', list(documentId === `t-${spec}` ? [
          new Map<string, unknown>([['type', 'thread'], ['id', 'open'], ['quote', 'Two.'], ['resolved', false], ['anchor', { kind: 'text-quote', exact: 'Two.' }],
            ['comments', list([new Map<string, unknown>([['id', 'c'], ['content', 'Say why'], ['timeStamp', 0], ['actor', { kind: 'user', displayName: 'Ana' }]])])]]),
          new Map<string, unknown>([['type', 'thread'], ['id', 'done'], ['quote', 'One.'], ['resolved', true],
            ['comments', list([new Map<string, unknown>([['id', 'd'], ['content', 'ok'], ['timeStamp', 0]])])]]),
        ] : [])],
      ]),
    });
    const content = {
      writeEditorPage: async () => ({ ok: true as const, outcome: 'seeded' as const }),
      uploadFile: async () => ({ ok: true as const, uri: 'x' }),
      readRoom: async <T>(documentId: string, read: (doc: unknown) => T) => ({ ok: true as const, value: read(docFor(documentId)) }),
    };
    const deps = { call: server.call, ...noWait, content };
    await publishLocalWikiToTeam(opened, {}, deps);

    const comments = await listPublishedComments(opened, {}, deps);
    expect(comments.pagesChecked).toBe(2);
    expect(comments.threads).toEqual([expect.objectContaining({ localId: spec, file: expect.stringMatching(/Spec\.md$/), threadId: 'open', quote: 'Two.', anchorState: 'quote', comments: [expect.objectContaining({ author: 'Ana', content: 'Say why' })] })]);

    server.editInTeam(spec, 'One.\nTwo, because reasons.\nThree.\n');
    const diff = await diffPublishedPage(opened, 'Spec', deps);
    expect(diff.identical).toBe(false);
    expect(diff.diff).toContain('-Two.\n+Two, because reasons.');
    expect(diff.diff).not.toContain('-One.');
  });

  it('sends a linked page in team form in one write, and takes back a page edited in the team once the file holds its text', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const target = (await wiki.command({ type: 'register-document', title: 'Target', parentFolderId: null, body: 't\n' })).id!;
    const linker = (await wiki.command({ type: 'register-document', title: 'Linker', parentFolderId: null, body: 'See [Target](Target.md).\n' })).id!;
    const server = fakeServer();
    const deps = { call: server.call, ...noWait };
    await publishLocalWikiToTeam(opened, {}, deps);
    const writesAfterFirst = server.pages.get(linker)!.writes;
    expect(server.pages.get(linker)!.body).toBe(`See [Target](https://console/t-${target}).\n`);

    // Unchanged file: nothing is rewritten (no marks dropped), and it counts as unchanged.
    const again = await publishLocalWikiToTeam(opened, {}, deps);
    expect(server.pages.get(linker)!.writes).toBe(writesAfterFirst);
    expect(again).toMatchObject({ unchanged: 3, updated: 0 });

    // A reviewer edits it in the team; the next local change is refused.
    server.editInTeam(linker, `See [Target](https://console/t-${target}), reviewed.\n`);
    await wiki.writeBody(linker, 'See [Target](Target.md), mine.\n', (await wiki.readBody(linker)).version);
    expect((await publishLocalWikiToTeam(opened, {}, deps)).bodyEdited).toEqual([expect.objectContaining({ localId: linker })]);

    // The file takes the team text (in local link form): no difference, and the publish takes the page back.
    await wiki.writeBody(linker, 'See [Target](Target.md), reviewed.\n', (await wiki.readBody(linker)).version);
    expect((await diffPublishedPage(opened, linker, deps)).identical).toBe(true);
    expect((await publishLocalWikiToTeam(opened, {}, deps)).bodyEdited).toEqual([]);
    await wiki.writeBody(linker, 'See [Target](Target.md), next.\n', (await wiki.readBody(linker)).version);
    const next = await publishLocalWikiToTeam(opened, {}, deps);
    expect(next.bodyEdited).toEqual([]);
    expect(server.pages.get(linker)!.body).toBe(`See [Target](https://console/t-${target}), next.\n`);
  });

  it('leaves out a page whose frontmatter does not parse, and keeps its team copy', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const spec = (await wiki.command({ type: 'register-document', title: 'Spec', parentFolderId: null, body: 'Public.\n', fields: { owner: 'Ana' } })).id!;
    const server = fakeServer();
    const deps = { call: server.call, ...noWait };
    await publishLocalWikiToTeam(opened, {}, deps);

    const file = path.join(opened.dir, 'Spec.md');
    writeFileSync(file, `---\nid: ${spec}\nowner: [Ana\n---\nPublic.\n`);
    await wiki.rescan();
    const report = await publishLocalWikiToTeam(opened, {}, deps);

    expect(report.skipped).toEqual([expect.objectContaining({ title: 'Spec', reason: expect.stringMatching(/frontmatter does not parse/) })]);
    expect(report.removals).toEqual([]);
    expect(server.calls.some((c) => c.name === 'deleteSharedItem')).toBe(false);
    // Nothing raw went out under a derived id.
    expect([...server.pages.keys()].some((id) => id.startsWith('bad'))).toBe(false);
    const manifest = JSON.parse(readFileSync(publishManifestPath(opened.projectRoot), 'utf8'));
    expect(manifest.pages[spec]).toMatchObject({ id: `t-${spec}` });
    expect(manifest.pages[spec].removedLocally).toBeUndefined();
  });

  it('guards removals: none with nothing exported, pending over the limit until confirmed, and none without the Home readback', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await wiki.command({ type: 'register-document', title: `P${i}`, parentFolderId: null, body: `p${i}\n` })).id!);
    const server = fakeServer();
    const deps = { call: server.call, ...noWait };
    await publishLocalWikiToTeam(opened, {}, deps);

    // Four of seven recorded pages gone: over max(3, 10%).
    for (const id of ids.slice(0, 4)) await wiki.command({ type: 'trash-document', documentId: id });
    const held = await publishLocalWikiToTeam(opened, {}, deps);
    expect(held.verified).toBe(true);
    expect(held.removals!.map((r) => r.action)).toEqual(['pending', 'pending', 'pending', 'pending']);
    expect(held.notes.join(' ')).toMatch(/--confirm-removals/);
    expect(server.calls.some((c) => c.name === 'deleteSharedItem')).toBe(false);

    // No Home readback: not verified, nothing removed even when confirmed.
    const home = (await wiki.snapshot()).pages.find((p) => p.title === 'Home')!.id;
    server.unreadable.add(home);
    expect((await publishLocalWikiToTeam(opened, { confirmRemovals: true }, deps)).verified).toBe(false);
    expect(server.calls.some((c) => c.name === 'deleteSharedItem')).toBe(false);
    server.unreadable.delete(home);

    const confirmed = await publishLocalWikiToTeam(opened, { confirmRemovals: true }, deps);
    expect(confirmed.removals!.map((r) => r.action)).toEqual(['trashed', 'trashed', 'trashed', 'trashed']);

    // Every page left out: refused before anything is sent.
    for (const page of (await wiki.snapshot()).pages.filter((p) => p.trashedAt === null)) {
      await wiki.command({ type: 'set-document-fields', documentId: page.id, fields: { export: false } });
    }
    const before = server.calls.length;
    await expect(publishLocalWikiToTeam(opened, { confirmRemovals: true }, deps)).rejects.toThrow(/No pages to publish/);
    expect(server.calls.length).toBe(before);
  });

  it('--init never creates a project when the recorded one is unreachable or the status is unexpected', async () => {
    const opened = await makeWiki();
    rmSync(path.join(opened.projectRoot, '.nimbalyst', 'wiki.json'));
    writePublishTarget(opened.projectRoot, PROJECT);
    const unbound = fakeServer({ bound: false });
    await expect(initPublish(opened, {}, { call: unbound.call, ...noWait })).rejects.toThrow(/not reachable.*rather than create another project/);
    const odd = fakeServer({ status: () => ({ state: 'project_not_accessible' }) });
    await expect(initPublish(opened, {}, { call: odd.call, ...noWait })).rejects.toThrow(/project_not_accessible/);
    for (const server of [unbound, odd]) expect(server.calls.some((c) => c.name === 'pages_create_project' || c.name === 'pages_import')).toBe(false);
  });

  it('verifies on the other pages when the local Home is left out or does not parse', async () => {
    const opened = await makeWiki();
    const { wiki } = opened;
    writePublishTarget(opened.projectRoot, PROJECT);
    const spec = (await wiki.command({ type: 'register-document', title: 'Spec', parentFolderId: null, body: 'Public.\n' })).id!;
    const homePage = (await wiki.snapshot()).pages.find((p) => p.title === 'Home')!;
    await wiki.command({ type: 'set-document-fields', documentId: homePage.id, fields: { export: false } });
    const server = fakeServer();
    const deps = { call: server.call, ...noWait };

    const leftOut = await publishLocalWikiToTeam(opened, {}, deps);
    expect(leftOut.verified).toBe(true);
    expect(leftOut.notes.join(' ')).toMatch(/no Home page/);
    expect(server.pages.has(homePage.id)).toBe(false);
    expect(JSON.parse(readFileSync(publishManifestPath(opened.projectRoot), 'utf8')).pages[spec]).toBeTruthy();

    // A Home whose frontmatter does not parse: same.
    writeFileSync(path.join(opened.dir, homePage.path!), '---\ntitle: [Home\n---\nStart.\n');
    await wiki.rescan();
    expect((await publishLocalWikiToTeam(opened, {}, deps)).verified).toBe(true);
  });
});
