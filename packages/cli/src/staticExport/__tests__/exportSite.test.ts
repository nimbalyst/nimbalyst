// @vitest-environment node
/**
 * `nim wiki export --static` over a real temp wiki: what the site holds, what
 * it leaves out, and that links point where a reader can follow them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { initWiki, openWiki, type LocalWiki, type ReadBodyResult, type StaticSiteLink, type StaticSiteManifest } from '@nimbalyst/local-wiki';
import { exportStaticSite, type CarriedTrackerItem } from '../exportSite.js';
import { normalizeBasePath } from '../sitePaths.js';
import { renderBodyHtml, type PrerenderSite } from '../prerender.js';
import { gatewayTrackerSource } from '../../commands/wikiExport.js';
import type { TrackerGateway } from '../../gateway/types.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture(): Promise<{ root: string; wiki: LocalWiki; assets: string }> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-export-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, 'app');
  mkdirSync(path.join(assets, 'assets'), { recursive: true });
  mkdirSync(path.join(assets, 'models'), { recursive: true });
  writeFileSync(path.join(assets, 'index.html'), '<!doctype html><html><head><title>Local wiki</title></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>');
  writeFileSync(path.join(assets, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(assets, 'models', 'editor-models.mjs'), '');
  await initWiki(path.join(root, 'wiki'));
  const wiki = await openWiki(path.join(root, 'wiki'), { repair: true });
  cleanups.push(() => wiki.close());
  return { root, wiki, assets };
}

const read = (file: string) => readFileSync(file, 'utf8');
const json = <T>(file: string) => JSON.parse(read(file)) as T;

describe('exportStaticSite', () => {
  it.each([['/', '/'], ['/docs', '/docs/'], ['/product/docs/', '/product/docs/'], ['/my wiki', '/my%20wiki/'], ['/my%20wiki/', '/my%20wiki/']])('normalizes base %s', (input, expected) => {
    expect(normalizeBasePath(input)).toBe(expected);
  });

  it.each(['', 'docs', 'https://example.com/docs', '//host/docs', '/docs?x=1', '/docs#top', '/a/../b', '/%2e%2e/', '/a//b', '/a%2fb', '/a%5cb', '/%zz'])('refuses invalid base %s before writing output', async (base) => {
    const { root, wiki, assets } = await fixture();
    const out = path.join(root, 'site');
    await expect(exportStaticSite({ wiki, assetsDir: assets, outDir: out, nimVersion: '9.9.9', base })).rejects.toThrow('--base');
    expect(existsSync(out)).toBe(false);
  });

  it('exports nested pages, assets and carried-item links under a site directory', async () => {
    const { root, wiki, assets } = await fixture();
    writeFileSync(path.join(assets, 'index.html'), '<html><head><title>Wiki</title><link rel="stylesheet" href="/assets/app.css"><link rel="modulepreload" href="/assets/shared.js"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>');
    const home = await wiki.command({ type: 'register-document', title: 'Home', parentFolderId: null, sortOrder: 0, body: '' });
    const group = await wiki.command({ type: 'register-document', title: 'Guide', parentFolderId: null, body: '' });
    const page = await wiki.command({ type: 'register-document', title: 'Setup', parentFolderId: group.id!, body: 'See [question](nimbalyst://USR.1).' });
    const out = path.join(root, 'site');
    await exportStaticSite({ wiki, assetsDir: assets, outDir: out, nimVersion: '9.9.9', base: '/product/docs', trackerItems: {
      find: async () => ({ id: 'q1', issueKey: 'USR.1', type: 'question', title: 'Question', fields: {}, body: '', createdAt: 1, updatedAt: 1 }),
    } });
    const html = read(path.join(out, 'guide/setup/index.html'));
    expect(html).toContain('src="/product/docs/assets/app.js"');
    expect(html).toContain('href="/product/docs/assets/app.css"');
    expect(html).toContain('href="/product/docs/assets/shared.js"');
    expect(html).toContain('"dataPath":"/product/docs/_wiki/","basePath":"/product/docs/"');
    expect(html).toContain('href="../../items/q1/">question</a>');
    expect(json<ReadBodyResult>(path.join(out, '_wiki/bodies', `${page.id}.json`)).markdown).toContain('](/product/docs/items/q1/)');
    expect(read(path.join(out, '404.html'))).toContain('src="/product/docs/assets/app.js"');
    expect(json<StaticSiteManifest>(path.join(out, '_wiki/manifest.json')).pages[home.id!]).toBe('');
    expect(existsSync(path.join(out, 'html-embed/shell/index.html'))).toBe(true);
    expect(existsSync(path.join(out, 'product'))).toBe(false);
  });

  it('writes a page per folder, leaves out export: false pages and person fields, and keeps links followable', async () => {
    const { root, wiki, assets } = await fixture();
    await wiki.command({ type: 'register-document', title: 'Home', parentFolderId: null, sortOrder: 0, body: 'Welcome.' });
    const home = (await wiki.snapshot()).pages.find((page) => page.title === 'Home')!;
    const competitors = await wiki.command({ type: 'register-document', title: 'Competitors', parentFolderId: null, body: '' });
    const secret = await wiki.command({ type: 'register-document', title: 'Secret', parentFolderId: null, fields: { export: false }, body: 'Do not publish.' });
    await wiki.command({ type: 'register-document', title: 'Under secret', parentFolderId: secret.id!, body: 'Also hidden.' });
    const acme = await wiki.command({
      type: 'register-document',
      title: 'Acme',
      parentFolderId: competitors.id!,
      fields: { status: 'active', owner: 'Dana', contact: 'dana@example.com' },
      body: 'placeholder',
    });
    const attachment = await wiki.storeAttachment(acme.id!, 'logo.png', new Uint8Array([1, 2, 3]));
    const snapshot = await wiki.snapshot();
    const acmePage = snapshot.pages.find((page) => page.id === acme.id)!;
    const secretPage = snapshot.pages.find((page) => page.id === secret.id)!;
    const homeRel = path.posix.relative(path.posix.dirname(acmePage.path!), home.path!);
    const secretRel = path.posix.relative(path.posix.dirname(acmePage.path!), secretPage.path!);
    await wiki.writeBody(acme.id!, [
      `Acme competes with us. See [Home](${encodeURI(homeRel)} "id=${home.id}").`,
      '',
      `Notes are in [the secret page](${encodeURI(secretRel)} "id=${secret.id}") and [NIM-12](nimbalyst://NIM-12).`,
      '',
      `![Logo](${attachment.link})`,
    ].join('\n'), null);

    const out = path.join(root, 'site');
    const report = await exportStaticSite({ wiki, assetsDir: assets, outDir: out, nimVersion: '9.9.9', now: () => new Date('2026-10-20T00:00:00Z') });

    // Left out: the opted-out page and its child, by reason.
    expect(report.excluded.map((entry) => [entry.title, entry.reason]).sort()).toEqual([['Secret', 'export-false'], ['Under secret', 'under-excluded']]);
    const manifest = json<StaticSiteManifest>(path.join(out, '_wiki', 'manifest.json'));
    expect(manifest.pages[acme.id!]).toBe('competitors/acme');
    expect(manifest.pages[secret.id!]).toBeUndefined();
    expect(manifest.homeId).toBe(home.id);
    expect(existsSync(path.join(out, '_wiki', 'bodies', `${secret.id}.json`))).toBe(false);
    expect(read(path.join(out, '_wiki', 'search.json'))).not.toContain('Do not publish');

    // Person fields are gone from every file a reader can fetch; other fields stay.
    const exportedAcme = json<{ pages: Array<{ id: string; fields: Record<string, unknown> }> }>(path.join(out, '_wiki', 'snapshot.json')).pages.find((page) => page.id === acme.id)!;
    expect(exportedAcme.fields).toEqual({ status: 'active' });
    expect(report.strippedFields).toBe(2);

    // A link to a left-out page and an app-only reference become their labels; the Home link stays.
    const body = json<ReadBodyResult>(path.join(out, '_wiki', 'bodies', `${acme.id}.json`)).markdown;
    expect(body).toContain(`[Home](${encodeURI(homeRel)} "id=${home.id}")`);
    expect(body).toContain('Notes are in the secret page and NIM-12.');
    expect(report.links.map((issue) => issue.kind).sort()).toEqual(['app-only', 'excluded-page']);

    // Home lists Acme under "Linked from"; the attachment is copied where the app looks for it.
    const links = json<Record<string, StaticSiteLink[]>>(path.join(out, '_wiki', 'links.json'));
    expect(links[home.id].map((link) => [link.direction, link.otherItemId])).toEqual([['in', acme.id]]);
    expect(existsSync(path.join(out, '_wiki', 'files', ...path.posix.join(path.posix.dirname(acmePage.path!), attachment.link).split('/')))).toBe(true);

    // The prerendered page: real HTML with links relative to its folder, and the app's boot config.
    const html = read(path.join(out, 'competitors', 'acme', 'index.html'));
    expect(html).toContain('<title>Acme · Home</title>');
    expect(html).toContain('href="../../">Home</a>');
    expect(html).not.toContain('Do not publish');
    expect(html).toContain('window.__NIMBALYST_WIKI_STATIC__={"format":1,"dataPath":"/_wiki/","basePath":"/"}');
    expect(read(path.join(out, 'index.html'))).toContain('<h2>Linked from</h2><ul><li><a href="./competitors/acme/">Acme</a>');
    // The app build is copied without its Node-only models or its unrendered shell.
    expect(existsSync(path.join(out, 'assets', 'app.js'))).toBe(true);
    expect(existsSync(path.join(out, 'models'))).toBe(false);
  });

  it('exports typed pages and table rows with their relations, leaves out excluded types, and never writes over a folder it did not make', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-export-types-')));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { assets } = await fixture();
    const typesDir = path.join(root, 'types');
    mkdirSync(typesDir);
    writeFileSync(path.join(typesDir, 'competitor.yaml'), 'type: competitor\ndisplayName: Competitor\ndisplayNamePlural: Competitors\nstorage: pages\nfields:\n  - name: title\n    type: string\n  - name: lead\n    type: user\n  - name: partner\n    type: relationship\n    itemType: partner\n');
    writeFileSync(path.join(typesDir, 'partner.yaml'), 'type: partner\ndisplayName: Partner\ndisplayNamePlural: Partners\nstorage: table\nfields:\n  - name: title\n    type: string\n');
    writeFileSync(path.join(typesDir, 'memo.yaml'), 'type: memo\ndisplayName: Memo\ndisplayNamePlural: Memos\nstorage: pages\nfields:\n  - name: title\n    type: string\n');
    await initWiki(path.join(root, 'wiki'));
    writeFileSync(path.join(root, 'wiki', 'Partners.csv'), 'id,title\nP1,Globex\n');
    const wiki = await openWiki(path.join(root, 'wiki'), { typesDir });
    cleanups.push(() => wiki.close());
    await wiki.command({ type: 'register-document', title: 'Home', parentFolderId: null, sortOrder: 0, body: 'Welcome.' });
    const acme = await wiki.trackerCommand('competitor', { type: 'create-item', item: { title: 'Acme', fields: { lead: 'Dana Lee', partner: 'P1' }, body: 'A competitor.' } });
    const memo = await wiki.trackerCommand('memo', { type: 'create-item', item: { title: 'Board memo', body: 'Private.' } });

    const out = path.join(root, 'site');
    await exportStaticSite({ wiki, assetsDir: assets, outDir: out, nimVersion: '9.9.9', excludeTypes: ['memo'] });
    const manifest = json<StaticSiteManifest>(path.join(out, '_wiki', 'manifest.json'));
    expect(manifest.pages[acme.id!]).toBe('acme');
    expect(manifest.pages.P1).toBe('items/p1');
    expect(manifest.pages[memo.id!]).toBeUndefined();
    expect(Object.keys(manifest.types).sort()).toEqual(['competitor', 'partner']);
    // The relationship field links Acme to the row both ways; the person field is gone.
    const links = json<Record<string, StaticSiteLink[]>>(path.join(out, '_wiki', 'links.json'));
    expect(links.P1).toEqual([expect.objectContaining({ direction: 'in', otherItemId: acme.id, sourceFieldId: 'partner' })]);
    const tracker = json<{ items: Array<{ id: string; fields: Record<string, unknown> }> }>(path.join(out, '_wiki', 'trackers', 'competitor.json'));
    expect(tracker.items.map((item) => [item.id, item.fields])).toEqual([[acme.id, expect.not.objectContaining({ lead: expect.anything() })]]);
    expect(read(path.join(out, 'types', 'partner', 'index.html'))).toContain('href="../../items/p1/">Globex</a>');

    // Re-exporting keeps the earlier site beside the new one; a folder with other files is refused untouched.
    const again = await exportStaticSite({ wiki, assetsDir: assets, outDir: out, nimVersion: '9.9.9' });
    expect(again.previous).toBe(`${out}.previous`);
    expect(existsSync(path.join(out, '_wiki', 'manifest.json'))).toBe(true);
    const busy = path.join(root, 'busy');
    mkdirSync(busy);
    writeFileSync(path.join(busy, 'notes.txt'), 'mine');
    await expect(exportStaticSite({ wiki, assetsDir: assets, outDir: busy, nimVersion: '9.9.9' })).rejects.toThrow(/not empty/);
    expect(read(path.join(busy, 'notes.txt'))).toBe('mine');
  });

  it('carries the app tracker items a page links to, with their own page, and leaves the rest as text', async () => {
    const { root, wiki, assets } = await fixture();
    const item = (overrides: Partial<CarriedTrackerItem>): CarriedTrackerItem => ({
      id: 'q1', issueKey: 'USR.64', type: 'question', title: 'Which plan?', fields: { title: 'Which plan?', status: 'open', owner: 'Dana' },
      body: 'Depends on [USR.65](nimbalyst://USR.65) and [USR.99](nimbalyst://USR.99).', createdAt: 1, updatedAt: 2, ...overrides,
    });
    const items = new Map([['USR.64', item({})], ['USR.65', item({ id: 'q2', issueKey: 'USR.65', title: 'Unreferenced', body: '' })]]);
    const asked: string[] = [];
    const trackerItems = { find: async (ref: string) => (asked.push(ref), items.get(ref) ?? null) };
    await wiki.command({ type: 'register-document', title: 'Home', parentFolderId: null, sortOrder: 0, body: 'See [the plan question](nimbalyst://USR.64) and [gone](nimbalyst://USR.7).' });

    const out = path.join(root, 'site');
    const report = await exportStaticSite({ wiki, assetsDir: assets, outDir: out, nimVersion: '9.9.9', trackerItems });
    // Only what the exported pages link to is looked up: not USR.65, which only the item links to.
    expect(asked.sort()).toEqual(['USR.64', 'USR.7']);
    expect(report.trackerItems).toBe(1);
    const manifest = json<StaticSiteManifest>(path.join(out, '_wiki', 'manifest.json'));
    expect(manifest.pages.q1).toBe('items/q1');
    expect(manifest.types.question).toBe('types/question');
    const home = Object.keys(manifest.pages).find((id) => manifest.pages[id] === '')!;
    expect(json<ReadBodyResult>(path.join(out, '_wiki', 'bodies', `${home}.json`)).markdown).toBe('See [the plan question](/items/q1/) and gone.');
    // The item: its fields without the person, its body with the uncarried reference as text, and who links to it.
    const tracker = json<{ items: Array<{ id: string; fields: Record<string, unknown> }> }>(path.join(out, '_wiki', 'trackers', 'question.json'));
    expect(tracker.items).toEqual([expect.objectContaining({ id: 'q1', fields: { title: 'Which plan?', status: 'open' } })]);
    expect(json<ReadBodyResult>(path.join(out, '_wiki', 'bodies', 'q1.json')).markdown).toBe('Depends on USR.65 and USR.99.');
    const links = json<Record<string, StaticSiteLink[]>>(path.join(out, '_wiki', 'links.json'));
    expect(links.q1).toEqual([expect.objectContaining({ direction: 'in', otherItemId: home })]);
    // Prerendered: Home links to the item page relatively; the item page shows its key and body.
    expect(read(path.join(out, 'index.html'))).toContain('<a href="./items/q1/">the plan question</a>');
    const page = read(path.join(out, 'items', 'q1', 'index.html'));
    expect(page).toContain('USR.64');
    expect(page).toContain('Depends on USR.65 and USR.99.');
  });

  it('reads a carried item from the app without the field header the running app puts on its body', async () => {
    const record = { id: 'q1', primaryType: 'question', typeTags: [], localKey: 'USR.84', source: 'native', archived: false, system: { createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }, fields: { title: 'Q3', status: 'open', description: 'x' } };
    const live = '# Q3\n\n**Type**: question\n**Issue Key**: USR.84\n**Status**: open\n**ID**: q1\n\n---\n\nSpike plan question Q3.';
    const gateway = (body: string, archived = false) => ({
      getTracker: async () => ({ ...record, archived }),
      getTrackerBody: async () => body,
    }) as unknown as TrackerGateway;
    expect(await gatewayTrackerSource(gateway(live), '/ws').find('USR.84')).toEqual({
      id: 'q1', issueKey: 'USR.84', type: 'question', title: 'Q3', fields: { title: 'Q3', status: 'open' },
      body: 'Spike plan question Q3.', createdAt: Date.parse('2026-10-01T00:00:00.000Z'), updatedAt: Date.parse('2026-10-02T00:00:00.000Z'),
    });
    // The database path returns the description as stored; a live item with no description has only the header.
    expect((await gatewayTrackerSource(gateway('Stored body.'), '/ws').find('USR.84'))?.body).toBe('Stored body.');
    expect((await gatewayTrackerSource(gateway('# Q3\n\n**Type**: question\n**ID**: q1'), '/ws').find('USR.84'))?.body).toBe('');
    expect(await gatewayTrackerSource(gateway('', true), '/ws').find('USR.84')).toBeNull();
  });
});

describe('renderBodyHtml', () => {
  const site: PrerenderSite = { pages: new Map(), included: new Set(), sitePaths: {}, basePath: '/' };
  const render = (markdown: string) => renderBodyHtml(markdown, { path: 'page.md', dir: '' }, site, './');

  it('keeps colored text colored, writing only the validated colors', () => {
    expect(render(`<span style='COLOR:teal'>**late**</span> and <span style="background-color: #ffd43b4d; color: rgb(1, 2, 3)">both</span>`))
      .toBe('<p><span style="color: teal"><strong>late</strong></span> and <span style="color: rgb(1, 2, 3); background-color: #ffd43b4d">both</span></p>\n');
  });

  it('leaves out other spans and their closing tags, and keeps escaped ones as text', () => {
    expect(render('<span class="x" style="color: red">a</span> <span style="color: url(x)">b</span> <span style="color: red">c <span onclick="x">d</span></span>'))
      .toBe('<p>a b <span style="color: red">c d</span></p>\n');
    expect(render(String.raw`\<span style="color: red">e</span>`)).toBe('<p>&lt;span style=&quot;color: red&quot;&gt;e</p>\n');
  });
});
