/**
 * `nim wiki export --static <dir>`: the wiki as a folder of static files any
 * host can serve. The browser app is the same build `nim wiki serve` uses; it
 * reads the files under `_wiki/` instead of the API (see `staticSite.ts` in
 * `@nimbalyst/local-wiki` for the layout) and shows every page read-only.
 *
 * What a reader must not see is left out before anything is written:
 * - pages with `export: false` in their frontmatter, and everything under them;
 * - pages whose frontmatter does not parse;
 * - person fields (owner, assignee, author and the like, `user` fields, and any
 *   value that is an email address), unless `keepIdentity`;
 * - the wiki's own bookkeeping: trash, activity logs, sidecars, absolute paths.
 *
 * Tracker items the app keeps (questions, decisions, `USR.64`) are carried
 * when an exported page links to one and `trackerItems` can look it up: each
 * gets an item page with its fields and body, and the link points there. Only
 * items the pages link to, not the items those link to; their person fields
 * are stripped like any other, and comments and activity are never read.
 *
 * The site is built in a sibling folder and swapped in at the end, so a failed
 * export never leaves half a site. An earlier export in the target is kept as
 * `<dir>.previous`; a target that holds anything else is refused.
 */
import { existsSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { isExportOptOut, stripIdentity } from './visibility.js';
import { HTML_EMBED_SHELL_CSP, HTML_EMBED_SHELL_HTML } from '@nimbalyst/collab-protocol';
import {
  findLinks,
  NIMBALYST_MARK_SVG,
  NIMBALYST_SITE_URL,
  STATIC_SITE_DATA_DIR,
  STATIC_SITE_FORMAT,
  type LocalPage,
  type LocalTrackerItem,
  type LocalWiki,
  type ReadBodyResult,
  type SearchDoc,
  type StaticSiteConfig,
  type StaticSiteLink,
  type StaticSiteManifest,
} from '@nimbalyst/local-wiki';
import { typeDefinitions, WIKI_API_VERSION } from '../serve/api.js';
import { rewriteBodyLinks, trackerRef, type LinkIssue, type OutsideRefs } from './bodyLinks.js';
import { describe, escapeHtml, pageHref, renderBodyHtml, renderShell, type PrerenderSite } from './prerender.js';
import { assignSitePaths, normalizeBasePath, rootPrefix } from './sitePaths.js';

export interface StaticExportOptions {
  wiki: LocalWiki;
  /** The built `@nimbalyst/wiki-web` (its `dist`). */
  assetsDir: string;
  outDir: string;
  nimVersion: string;
  /** Site title; default the Home page's title. */
  title?: string;
  /** URL path where the output folder will be hosted; defaults to `/`. */
  base?: string;
  outsideRefs?: OutsideRefs;
  keepIdentity?: boolean;
  /** Export only this page and what is under it. */
  rootPageId?: string;
  /** Types left out: their typed pages, table rows and type pages, and carried tracker items. */
  excludeTypes?: readonly string[];
  /** Looks up the tracker items exported pages link to; without it those links stay text. */
  trackerItems?: TrackerItemSource;
  now?: () => Date;
}

/** A tracker item from the app, as the export carries it. */
export interface CarriedTrackerItem {
  id: string;
  /** `USR.64`; null when the item has none. */
  issueKey: string | null;
  type: string;
  title: string;
  fields: Record<string, unknown>;
  /** Markdown; empty when the item has no body. */
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface TrackerItemSource {
  /** The item an issue key or id names; null when there is none. */
  find(ref: string): Promise<CarriedTrackerItem | null>;
}

export interface ExcludedPage {
  id: string;
  title: string;
  reason: 'export-false' | 'under-excluded' | 'outside-root' | 'malformed' | 'excluded-type';
}

export interface StaticExportReport {
  outDir: string;
  /** The earlier export moved aside, when there was one. */
  previous: string | null;
  pages: number;
  typedPages: number;
  rows: number;
  /** Tracker items carried because a page links to them. */
  trackerItems: number;
  types: number;
  files: number;
  excluded: ExcludedPage[];
  strippedFields: number;
  links: LinkIssue[];
}

export class StaticExportError extends Error {}

const MANIFEST = path.posix.join(STATIC_SITE_DATA_DIR, 'manifest.json');

function relationIds(value: unknown): string[] {
  if (typeof value === 'string') return value.split(',').map((part) => part.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(relationIds);
  // A wiki relationship holds `{ id }`; one from the app's tracker holds `{ itemId }`.
  if (value && typeof value === 'object') {
    const { id, itemId } = value as { id?: unknown; itemId?: unknown };
    if (typeof id === 'string') return [id];
    if (typeof itemId === 'string') return [itemId];
  }
  return [];
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

async function writeText(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** Refuses a target that is not empty and not an earlier export. */
async function checkTarget(outDir: string): Promise<'absent' | 'empty' | 'export'> {
  if (!existsSync(outDir)) return 'absent';
  if (!statSync(outDir).isDirectory()) throw new StaticExportError(`${outDir} is a file, not a folder.`);
  const entries = await readdir(outDir);
  if (entries.length === 0) return 'empty';
  if (existsSync(path.join(outDir, MANIFEST))) return 'export';
  throw new StaticExportError(`${outDir} is not empty and is not an earlier wiki export. Pick an empty or new folder.`);
}

/** A file name for the file the type of `typeId` writes; type ids are tokens, but a path never trusts that. */
function dataName(id: string): string {
  return encodeURIComponent(id);
}

export async function exportStaticSite(options: StaticExportOptions): Promise<StaticExportReport> {
  const { wiki } = options;
  let basePath: string;
  try { basePath = normalizeBasePath(options.base); } catch (error) {
    throw new StaticExportError((error as Error).message);
  }
  const outDir = path.resolve(options.outDir);
  const outsideRefs = options.outsideRefs ?? 'text';
  const keepIdentity = options.keepIdentity ?? false;
  const target = await checkTarget(outDir);
  if (!existsSync(path.join(options.assetsDir, 'index.html'))) throw new StaticExportError(`${options.assetsDir} has no index.html; the browser app is not built.`);
  const template = await readFile(path.join(options.assetsDir, 'index.html'), 'utf8');

  const snapshot = await wiki.snapshot();
  const excludedTypes = new Set(options.excludeTypes ?? []);
  const allTypeDefs = await typeDefinitions(wiki);
  const unknownType = [...excludedTypes].find((typeId) => !allTypeDefs.some((def) => def.typeId === typeId));
  if (unknownType) throw new StaticExportError(`No type ${unknownType} in .nimbalyst/trackers.`);
  // Only types whose items live in the wiki; bugs, tasks and other app types have nothing to show here.
  const typeDefs = allTypeDefs.filter((def) => def.wikiType && !excludedTypes.has(def.typeId));
  const typeById = new Map(typeDefs.map((def) => [def.typeId, def]));
  const userFieldsOf = (typeId: string | null) => new Set((typeId ? typeById.get(typeId)?.fields ?? [] : []).filter((field) => field.type === 'user').map((field) => field.name));

  // ---------------------------------------------------------------- what is in
  const live = new Map(snapshot.pages.filter((page) => page.trashedAt === null).map((page) => [page.id, page]));
  const children = new Map<string | null, LocalPage[]>();
  for (const page of live.values()) {
    const siblings = children.get(page.parentId) ?? [];
    siblings.push(page);
    children.set(page.parentId, siblings);
  }
  const excluded: ExcludedPage[] = [];
  const included = new Set<string>();
  const visited = new Set<string>();
  /** `hidden`: an ancestor has `export: false`. A malformed page is left out alone; its children are fine. */
  const visit = (page: LocalPage, hidden: boolean) => {
    if (visited.has(page.id)) return;
    visited.add(page.id);
    const optedOut = isExportOptOut(page.fields);
    if (hidden) excluded.push({ id: page.id, title: page.title, reason: 'under-excluded' });
    else if (optedOut) excluded.push({ id: page.id, title: page.title, reason: 'export-false' });
    else if (page.malformed) excluded.push({ id: page.id, title: page.title, reason: 'malformed' });
    // Only the typed page itself: plain pages under it are not of that type.
    else if (page.type && excludedTypes.has(page.type)) excluded.push({ id: page.id, title: page.title, reason: 'excluded-type' });
    else included.add(page.id);
    for (const child of children.get(page.id) ?? []) visit(child, hidden || optedOut);
  };
  if (options.rootPageId) {
    const root = live.get(options.rootPageId);
    if (!root) throw new StaticExportError(`No page ${options.rootPageId} in the wiki.`);
    visit(root, false);
  } else {
    for (const page of children.get(null) ?? []) visit(page, false);
    // A page whose parent is not a live page is not reached from the top; it shows at the top of the tree.
    for (const page of live.values()) visit(page, false);
  }
  for (const page of live.values()) if (!visited.has(page.id)) excluded.push({ id: page.id, title: page.title, reason: 'outside-root' });

  // Table rows: every row of a table whose placement is exported (or at the top).
  const tableTypes = typeDefs.filter((def) => def.storage === 'table');
  const rows: LocalTrackerItem[] = [];
  const trackerSnapshots = new Map<string, Awaited<ReturnType<LocalWiki['trackerSnapshot']>>>();
  for (const def of typeDefs) {
    const trackers = await wiki.trackerSnapshot(def.typeId);
    trackerSnapshots.set(def.typeId, trackers);
  }
  for (const def of tableTypes) {
    for (const row of trackerSnapshots.get(def.typeId)?.items ?? []) {
      if (!row.parentId || included.has(row.parentId)) rows.push(row);
    }
  }
  const rowIds = new Set(rows.map((row) => row.id));
  const exportedPages = [...live.values()].filter((page) => included.has(page.id));
  // Home is the first top-level page, as the app picks it.
  const home = exportedPages
    .filter((page) => page.parentId === null)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title))[0] ?? null;
  // ---------------------------------------------------------------- bodies, read once
  const rawBodies = new Map<string, ReadBodyResult>();
  for (const page of exportedPages) {
    if (page.bodySource === 'none' && page.documentType === 'markdown') continue;
    const body = await wiki.readBody(page.id);
    if (!body.malformed) rawBodies.set(page.id, body);
  }

  // ---------------------------------------------------------------- carried tracker items
  const carried = new Map<string, CarriedTrackerItem>();
  /** Reference as written (`USR.64`, an id) to the carried item's id. */
  const carriedByRef = new Map<string, string>();
  if (options.trackerItems) {
    const refs = new Set<string>();
    for (const [id, body] of rawBodies) {
      if (live.get(id)?.documentType !== 'markdown') continue;
      for (const link of findLinks(body.markdown)) {
        const ref = trackerRef(link.path);
        if (ref && !included.has(ref)) refs.add(ref);
      }
    }
    for (const ref of refs) {
      const item = await options.trackerItems.find(ref);
      if (!item || included.has(item.id) || excludedTypes.has(item.type)) continue;
      carried.set(item.id, item);
      carriedByRef.set(ref, item.id);
    }
  }
  // Their types: a wiki type in the export takes them in; any other is defined from its type file,
  // or, for a built-in type with no file here, from the fields its items have.
  const carriedTypeDefs: typeof typeDefs = [];
  for (const typeId of new Set([...carried.values()].map((item) => item.type))) {
    if (typeById.has(typeId)) continue;
    const known = allTypeDefs.find((def) => def.typeId === typeId);
    const fieldNames = new Set([...carried.values()].filter((item) => item.type === typeId).flatMap((item) => Object.keys(item.fields)));
    const label = typeId.charAt(0).toUpperCase() + typeId.slice(1).replace(/[-_]/g, ' ');
    const def = known
      ? { ...known, storage: 'pages' as const, problems: [] }
      : { typeId, displayName: label, displayNamePlural: `${label}s`, storage: 'pages' as const, wikiType: false, fields: [...fieldNames].map((name) => ({ name, type: 'string' })), titleField: 'title', definition: null, problems: [] };
    carriedTypeDefs.push(def);
    typeById.set(typeId, def);
  }
  const siteTypeDefs = [...typeDefs, ...carriedTypeDefs];
  const carriedRows: LocalTrackerItem[] = [...carried.values()].map((item) => ({
    id: item.id,
    type: item.type,
    title: item.title,
    fields: item.fields,
    storage: 'pages',
    path: null,
    parentId: null,
    parentKind: null,
    order: null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

  const sitePaths = assignSitePaths(exportedPages, [...rows, ...carriedRows], siteTypeDefs.map((def) => def.typeId), home?.id ?? null);
  const title = options.title?.trim() || home?.title || 'Wiki';

  // ---------------------------------------------------------------- bodies
  const wikiRoot = path.resolve(wiki.root);
  const fileExists = (rel: string) => {
    if (rel.split('/').some((part) => part.startsWith('.') && part !== '.assets')) return false;
    const abs = path.resolve(wikiRoot, rel);
    if (abs !== wikiRoot && !abs.startsWith(wikiRoot + path.sep)) return false;
    try {
      return statSync(abs).isFile();
    } catch {
      return false;
    }
  };
  const trackerItem = (ref: string) => {
    const id = carriedByRef.get(ref) ?? (carried.has(ref) ? ref : undefined);
    return id ? { id, href: `${basePath}${sitePaths.pages[id].split('/').map(encodeURIComponent).join('/')}/` } : null;
  };
  const linkContext = { pages: live, included, outsideRefs, fileExists, trackerItem };
  const bodies = new Map<string, ReadBodyResult>();
  const linkIssues: LinkIssue[] = [];
  const files = new Set<string>();
  const links = new Map<string, StaticSiteLink[]>();
  const addLink = (id: string, link: StaticSiteLink) => {
    const list = links.get(id) ?? [];
    list.push(link);
    links.set(id, list);
  };
  const titleOf = (id: string) => live.get(id)?.title ?? rows.find((row) => row.id === id)?.title ?? carried.get(id)?.title ?? id;
  const typeOf = (id: string) => live.get(id)?.type ?? rows.find((row) => row.id === id)?.type ?? carried.get(id)?.type ?? 'page';
  const carriedPage = (item: CarriedTrackerItem) => ({ id: item.id, title: item.title, path: null, dir: '' });

  const rewrite = (source: { id: string; title: string; path: string | null; dir: string; type: string | null }, markdown: string, version: string, inTrackerItem = false) => {
    const rewritten = rewriteBodyLinks(source, markdown, linkContext);
    bodies.set(source.id, { markdown: rewritten.markdown, version });
    linkIssues.push(...(inTrackerItem ? rewritten.issues.map((issue) => ({ ...issue, inTrackerItem })) : rewritten.issues));
    for (const file of rewritten.files) files.add(file);
    const seen = new Set<string>();
    for (const out of rewritten.outgoing) {
      if (out.targetId === source.id || seen.has(out.targetId)) continue;
      seen.add(out.targetId);
      const base = { predicateId: null, relationshipTypeKey: 'link', otherIssueKey: null, sentence: out.sentence || null, sourceFieldId: 'body:link' };
      addLink(source.id, { ...base, direction: 'out', otherItemId: out.targetId, otherTitle: titleOf(out.targetId), otherTypeId: typeOf(out.targetId) });
      addLink(out.targetId, { ...base, direction: 'in', otherItemId: source.id, otherTitle: source.title, otherTypeId: source.type ?? 'page' });
    }
  };
  for (const page of exportedPages) {
    const body = rawBodies.get(page.id);
    if (!body) continue;
    if (page.documentType !== 'markdown') bodies.set(page.id, body);
    else rewrite(page, body.markdown, body.version);
  }
  for (const item of carried.values()) rewrite({ ...carriedPage(item), type: item.type }, item.body, String(item.updatedAt), true);

  // Relationship fields, read before identity fields are stripped (a relation is not a person).
  const fieldSources: Array<{ id: string; type: string; title: string; fields: Record<string, unknown> }> = [
    ...exportedPages.filter((page) => page.type).map((page) => ({ id: page.id, type: page.type!, title: page.title, fields: page.fields })),
    ...rows.map((row) => ({ id: row.id, type: row.type, title: row.title, fields: row.fields })),
    ...carriedRows.map((row) => ({ id: row.id, type: row.type, title: row.title, fields: row.fields })),
  ];
  for (const source of fieldSources) {
    for (const field of typeById.get(source.type)?.fields ?? []) {
      if (field.type !== 'relationship') continue;
      for (const targetId of relationIds(source.fields[field.name])) {
        if (!included.has(targetId) && !rowIds.has(targetId) && !carried.has(targetId)) continue;
        const base = { predicateId: null, relationshipTypeKey: null, otherIssueKey: null, sentence: null, sourceFieldId: field.name };
        addLink(source.id, { ...base, direction: 'out', otherItemId: targetId, otherTitle: titleOf(targetId), otherTypeId: typeOf(targetId) });
        addLink(targetId, { ...base, direction: 'in', otherItemId: source.id, otherTitle: source.title, otherTypeId: source.type });
      }
    }
  }

  // ---------------------------------------------------------------- fields
  let strippedFields = 0;
  const strip = (fields: Record<string, unknown>, typeId: string | null) => {
    const result = stripIdentity(fields, userFieldsOf(typeId), keepIdentity);
    strippedFields += result.removed;
    return result.fields;
  };
  const pageFields = new Map(exportedPages.map((page) => [page.id, strip(page.fields, page.type)]));
  const exportedRows = rows.map((row) => ({ ...row, fields: strip(row.fields, row.type) }));
  const exportedCarried = carriedRows.map((row) => ({ ...row, fields: strip(row.fields, row.type) }));

  // ---------------------------------------------------------------- write
  const stage = `${outDir}.export-${process.pid}-${Date.now()}`;
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    const data = (rel: string) => path.join(stage, STATIC_SITE_DATA_DIR, rel);

    // The app's build, minus the page shell (written per page below) and the Node-only models.
    await cp(options.assetsDir, stage, {
      recursive: true,
      filter: (source) => {
        const rel = path.relative(options.assetsDir, source).split(path.sep).join('/');
        return rel !== 'index.html' && rel !== 'models' && !rel.startsWith('models/');
      },
    });

    const manifest: StaticSiteManifest = {
      format: STATIC_SITE_FORMAT,
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
      title,
      nimVersion: options.nimVersion,
      homeId: home?.id ?? null,
      pages: sitePaths.pages,
      types: sitePaths.types,
    };
    await writeJson(data('manifest.json'), manifest);
    await writeJson(data('info.json'), { apiVersion: WIKI_API_VERSION, version: options.nimVersion, root: '', projectRoot: null });

    const exportedSnapshot = {
      ...snapshot,
      items: snapshot.items.filter((item) => included.has(item.documentId)).map((item) => ({ ...item, fields: item.fields ? pageFields.get(item.documentId) ?? {} : item.fields })),
      itemPlacements: snapshot.itemPlacements.filter((placement) => included.has(placement.itemId) && (!placement.parentId || included.has(placement.parentId))),
      typePlacements: snapshot.typePlacements.map((placement) => (placement.parentFolderId && !included.has(placement.parentFolderId) ? { ...placement, parentFolderId: null, parentKind: undefined } : placement)),
      pages: exportedPages.map((page) => ({ ...page, fields: pageFields.get(page.id) ?? {} })),
      tables: snapshot.tables.map((table) => (table.parentId && !included.has(table.parentId) ? { ...table, parentId: null, parentKind: null } : table)),
      issues: [],
    };
    await writeJson(data('snapshot.json'), exportedSnapshot);
    // The type files' absolute paths stay on this machine.
    await writeJson(data('types.json'), { types: siteTypeDefs.map((def) => ({ ...def, problems: [] })) });
    for (const def of siteTypeDefs) {
      const trackers = trackerSnapshots.get(def.typeId) ?? { typeId: def.typeId, storage: 'pages' as const, items: [], version: null };
      const items = def.storage === 'table'
        ? exportedRows.filter((row) => row.type === def.typeId)
        : trackers.items.filter((item) => included.has(item.id)).map((item) => ({ ...item, fields: pageFields.get(item.id) ?? {} }));
      items.push(...exportedCarried.filter((row) => row.type === def.typeId));
      await writeJson(data(`trackers/${dataName(def.typeId)}.json`), { ...trackers, items });
    }
    for (const [id, body] of bodies) await writeJson(data(`bodies/${dataName(id)}.json`), body);

    const searchDocs: SearchDoc[] = [
      ...exportedPages.map((page) => ({
        id: page.id,
        title: page.title,
        kind: 'page' as const,
        type: page.type,
        path: page.path,
        // An editor page's file is data, not prose.
        body: page.documentType === 'markdown' ? bodies.get(page.id)?.markdown ?? '' : '',
        fields: pageFields.get(page.id) ?? {},
      })),
      ...exportedRows.map((row) => ({ id: row.id, title: row.title, kind: 'row' as const, type: row.type, path: row.path, body: '', fields: row.fields })),
      ...exportedCarried.map((row) => ({ id: row.id, title: row.title, kind: 'row' as const, type: row.type, path: null, body: bodies.get(row.id)?.markdown ?? '', fields: row.fields })),
    ];
    await writeJson(data('search.json'), searchDocs);
    await writeJson(data('links.json'), Object.fromEntries(links));

    for (const rel of files) {
      const destination = path.join(stage, STATIC_SITE_DATA_DIR, 'files', ...rel.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(wikiRoot, ...rel.split('/')), destination);
    }

    // The HTML embed sandbox. Its CSP header becomes a meta tag; the frame's own
    // `sandbox` attribute is what keeps embedded HTML in an opaque origin.
    const metaCsp = HTML_EMBED_SHELL_CSP.split(';').map((part) => part.trim()).filter((part) => !part.startsWith('sandbox')).join('; ');
    const shell = HTML_EMBED_SHELL_HTML.includes('<head>')
      ? HTML_EMBED_SHELL_HTML.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${escapeHtml(metaCsp)}">`)
      : `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(metaCsp)}">${HTML_EMBED_SHELL_HTML}`;
    await writeText(path.join(stage, 'html-embed', 'shell', 'index.html'), shell);

    // ---------------------------------------------------------------- pages
    const config: StaticSiteConfig = { format: STATIC_SITE_FORMAT, dataPath: `${basePath}${STATIC_SITE_DATA_DIR}/`, basePath };
    const site: PrerenderSite = { pages: live, included, sitePaths: sitePaths.pages, basePath };
    const writePage = (sitePath: string, pageTitle: string, description: string, content: string) =>
      writeText(path.join(stage, ...sitePath.split('/').filter(Boolean), 'index.html'), renderShell(template, title, { sitePath, title: pageTitle, description, content }, config));
    const nav = (prefix: string, current: string | null) => renderNav(prefix, current, exportedPages, children, included, sitePaths.pages, siteTypeDefs, sitePaths.types);

    const fieldLink = (prefix: string) => (id: string) =>
      sitePaths.pages[id] ? `<a href="${escapeHtml(pageHref(prefix, sitePaths.pages[id]))}">${escapeHtml(titleOf(id))}</a>` : null;
    for (const page of exportedPages) {
      const body = page.documentType === 'markdown' ? bodies.get(page.id)?.markdown ?? '' : '';
      const render = (prefix: string) => layout(nav(prefix, page.id), [
        `<h1>${escapeHtml(page.title || 'Untitled')}</h1>`,
        page.type ? renderFields(pageFields.get(page.id) ?? {}, typeById.get(page.type)?.fields ?? [], fieldLink(prefix)) : '',
        page.documentType === 'markdown' ? renderBodyHtml(body, page, site, prefix) : `<p>This page is a ${escapeHtml(page.documentType)} file. It shows once the site's scripts load.</p>`,
        renderBacklinks(links.get(page.id) ?? [], prefix, sitePaths.pages),
      ].join('\n'));
      const sitePath = sitePaths.pages[page.id];
      await writePage(sitePath, page.title, describe(body), render(rootPrefix(sitePath)));
    }
    for (const row of exportedRows) {
      const sitePath = sitePaths.pages[row.id];
      const prefix = rootPrefix(sitePath);
      const fields = renderFields(row.fields, typeById.get(row.type)?.fields ?? [], fieldLink(prefix));
      await writePage(sitePath, row.title, '', layout(nav(prefix, null), `<h1>${escapeHtml(row.title)}</h1>\n${fields}\n${renderBacklinks(links.get(row.id) ?? [], prefix, sitePaths.pages)}`));
    }
    for (const item of exportedCarried) {
      const source = carried.get(item.id)!;
      const sitePath = sitePaths.pages[item.id];
      const prefix = rootPrefix(sitePath);
      const markdown = bodies.get(item.id)?.markdown ?? '';
      const heading = `<h1>${escapeHtml(item.title || 'Untitled')}</h1>${source.issueKey ? `\n<p class="wiki-static-fields">${escapeHtml(source.issueKey)}</p>` : ''}`;
      const fields = renderFields(item.fields, typeById.get(item.type)?.fields ?? [], fieldLink(prefix));
      const content = [heading, fields, markdown ? renderBodyHtml(markdown, carriedPage(source), site, prefix) : '', renderBacklinks(links.get(item.id) ?? [], prefix, sitePaths.pages)].join('\n');
      await writePage(sitePath, item.title, describe(markdown), layout(nav(prefix, null), content));
    }
    for (const def of siteTypeDefs) {
      const sitePath = sitePaths.types[def.typeId];
      const prefix = rootPrefix(sitePath);
      const items = def.storage === 'table'
        ? exportedRows.filter((row) => row.type === def.typeId)
        : [...exportedPages.filter((page) => page.type === def.typeId), ...exportedCarried.filter((row) => row.type === def.typeId)];
      const list = items.length
        ? `<ul>${items.map((item) => `<li><a href="${escapeHtml(pageHref(prefix, sitePaths.pages[item.id]))}">${escapeHtml(item.title || 'Untitled')}</a></li>`).join('')}</ul>`
        : '<p>No items.</p>';
      await writePage(sitePath, def.displayNamePlural, '', layout(nav(prefix, null), `<h1>${escapeHtml(def.displayNamePlural)}</h1>\n${list}`));
    }
    await writePage('search', 'Search', '', layout(nav('../', null), '<h1>Search</h1>\n<p>Search runs in the page once its scripts load.</p>'));
    const typesList = siteTypeDefs.map((def) => `<li><a href="../${escapeHtml(sitePaths.types[def.typeId])}/">${escapeHtml(def.displayNamePlural)}</a></li>`).join('');
    await writePage('types', 'Types', '', layout(nav('../', null), `<h1>Types</h1>\n<ul>${typesList}</ul>`));
    if (!home) await writePage('', title, '', layout(nav('./', null), `<h1>${escapeHtml(title)}</h1>\n<p>This wiki has no pages.</p>`));
    // Hosts that serve `404.html` for unknown paths boot the app there, which says the page is not in the wiki.
    await writeText(path.join(stage, '404.html'), renderShell(template, title, { sitePath: '', title: 'Not found', description: '', content: '' }, config));

    // ---------------------------------------------------------------- swap in
    let previous: string | null = null;
    if (target === 'export') {
      previous = `${outDir}.previous`;
      await rm(previous, { recursive: true, force: true });
      await rename(outDir, previous);
    } else if (target === 'empty') {
      await rm(outDir, { recursive: true, force: true });
    }
    await rename(stage, outDir);

    return {
      outDir,
      previous,
      pages: exportedPages.filter((page) => !page.type).length,
      typedPages: exportedPages.filter((page) => page.type).length,
      rows: exportedRows.length,
      trackerItems: exportedCarried.length,
      types: siteTypeDefs.length,
      files: files.size,
      excluded,
      strippedFields,
      links: linkIssues,
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function layout(nav: string, article: string): string {
  const made = `<a class="wiki-static-made-with" href="${NIMBALYST_SITE_URL}" target="_blank" rel="noopener">${NIMBALYST_MARK_SVG}<span>Made with Nimbalyst</span></a>`;
  return `<div class="wiki-static-prerender"><nav class="wiki-static-nav">${nav}${made}</nav><article class="wiki-static-article">${article}</article></div>`;
}

/**
 * The prerendered tree: top-level pages, the open page's ancestors and its
 * children. Every page is reachable from Home this way, and no page carries
 * the whole tree.
 */
function renderNav(
  prefix: string,
  currentId: string | null,
  pages: readonly LocalPage[],
  children: ReadonlyMap<string | null, LocalPage[]>,
  included: ReadonlySet<string>,
  sitePaths: Readonly<Record<string, string>>,
  types: ReadonlyArray<{ typeId: string; displayNamePlural: string }>,
  typePaths: Readonly<Record<string, string>>,
): string {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const open = new Set<string>();
  for (let current = currentId ? byId.get(currentId) : undefined; current; current = current.parentId ? byId.get(current.parentId) : undefined) open.add(current.id);
  const sorted = (list: readonly LocalPage[]) => [...list].filter((page) => included.has(page.id)).sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.title.localeCompare(b.title));
  const item = (page: LocalPage): string => {
    const label = escapeHtml(page.title || 'Untitled');
    const link = page.id === currentId ? `<strong>${label}</strong>` : `<a href="${escapeHtml(pageHref(prefix, sitePaths[page.id]))}">${label}</a>`;
    const kids = open.has(page.id) ? sorted(children.get(page.id) ?? []) : [];
    return `<li>${link}${kids.length ? `<ul>${kids.map(item).join('')}</ul>` : ''}</li>`;
  };
  const typeLinks = types.map((type) => `<li><a href="${escapeHtml(pageHref(prefix, typePaths[type.typeId]))}">${escapeHtml(type.displayNamePlural)}</a></li>`).join('');
  return `<ul>${sorted(children.get(null) ?? []).map(item).join('')}</ul>${typeLinks ? `<p>Types</p><ul>${typeLinks}</ul>` : ''}`;
}

function fieldValue(value: unknown): string {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) return value.map(fieldValue).filter(Boolean).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function renderFields(fields: Record<string, unknown>, defs: ReadonlyArray<{ name: string; type: string }>, linkFor: (id: string) => string | null): string {
  const names = [...defs.map((def) => def.name).filter((name) => name in fields), ...Object.keys(fields).filter((name) => !defs.some((def) => def.name === name))];
  const rows = names
    .filter((name) => name !== 'title' && name !== 'paths')
    .map((name) => {
      const def = defs.find((candidate) => candidate.name === name);
      const value = fields[name];
      const shown = def?.type === 'relationship'
        ? relationIds(value).map((id) => linkFor(id) ?? escapeHtml(id)).join(', ')
        : escapeHtml(fieldValue(value));
      return shown ? `<tr><th>${escapeHtml(name)}</th><td>${shown}</td></tr>` : '';
    })
    .filter(Boolean);
  return rows.length ? `<table class="wiki-static-fields">${rows.join('')}</table>` : '';
}

function renderBacklinks(links: readonly StaticSiteLink[], prefix: string, sitePaths: Readonly<Record<string, string>>): string {
  const incoming = links.filter((link) => link.direction === 'in' && sitePaths[link.otherItemId] !== undefined);
  if (incoming.length === 0) return '';
  const unique = [...new Map(incoming.map((link) => [link.otherItemId, link])).values()];
  return `<h2>Linked from</h2><ul>${unique.map((link) => `<li><a href="${escapeHtml(pageHref(prefix, sitePaths[link.otherItemId]))}">${escapeHtml(link.otherTitle || 'Untitled')}</a></li>`).join('')}</ul>`;
}
