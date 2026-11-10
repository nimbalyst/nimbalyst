/**
 * The local wiki as `pages_import` entries, for moving it to a team project:
 * pages and typed pages in tree order (a parent always before its children),
 * table rows as typed pages, editor pages, the wiki types they use, the files
 * pages link to, and the link rewrite that runs once the server has assigned
 * every page its team link.
 *
 * An editor page (drawing, spreadsheet, ...) is registered by `pages_import`
 * with an empty body; its file text is kept here for the move to write into
 * its team document. An editor page the move cannot write (no codec for its
 * type) is reported as skipped and its children move up to the nearest
 * imported page.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { findLinks, rewriteFileLinks, type LocalPage, type LocalWiki } from '@nimbalyst/local-wiki';
import { buildTree, livePages } from './tree.js';
import { isExportOptOut, stripIdentity } from '../staticExport/visibility.js';

export interface ImportPage {
  localId: string;
  parentLocalId: string | null;
  title: string;
  order?: number;
  kind: 'page' | 'typedPage' | 'editorPage';
  typeId?: string;
  /** A table row: it sits under its type in the team tree, not under `parentLocalId`. */
  underType?: boolean;
  /** An editor page's document type, file extension and the extension that edits it. */
  documentType?: string;
  fileExtension?: string;
  editorId?: string;
  fields?: Record<string, unknown>;
  body: string;
}

/**
 * The extension that edits each editor page type in Nimbalyst, the `editorId`
 * a team document is registered with. Keys match `DEFAULT_EDITOR_TYPES` in
 * `@nimbalyst/local-wiki`; values are each extension's manifest id.
 */
export const EDITOR_IDS: Readonly<Record<string, string>> = {
  excalidraw: 'com.nimbalyst.excalidraw',
  mindmap: 'com.nimbalyst.mindmap',
  datamodel: 'com.nimbalyst.datamodellm',
  'mockup.html': 'com.nimbalyst.mockuplm',
  csv: 'com.nimbalyst.csv-spreadsheet',
  'calc.md': 'com.nimbalyst.calc-sheets',
  canvas: 'com.nimbalyst.canvas',
  // A host-owned page type with no extension; desktop and the web console edit it.
  html: 'builtin.html',
};

/** A file a markdown page links to (an image, an attachment), as written and where it is on disk. */
export interface LinkedFile {
  /** The link's decoded path, as `rewriteFileLinks` reports it. */
  linkPath: string;
  /** Absolute path, or null when the link points at no file in the wiki. */
  abs: string | null;
}

export interface ImportType {
  id: string;
  name: string;
  definition: unknown;
}

/** Where a type sits in the team page tree: under an imported page, or at the top. */
export interface ImportTypePlacement {
  typeId: string;
  parentLocalId: string | null;
  order?: number;
}

export interface SkippedPage {
  localId: string;
  title: string;
  reason: string;
  /** Left out on purpose (`export: false`), not for want of an editor; a publish removes its team copy. */
  excluded?: true;
}

/** Where a page sits, for resolving path-only links. */
interface PageLocation {
  path: string | null;
  dir: string;
}

export interface CollectOptions {
  /**
   * Editor page types the move can write into a team document, or a reason
   * none can (the editors' document code is not installed). Default: none.
   */
  editorTypes?: ReadonlySet<string> | { unavailable: string };
  /** The wiki folder relative to the project root (posix, '' when it is the root), for canvas card paths. */
  wikiPrefix?: string;
  /** The wiki folder's absolute path, for canvas cards that name a file by absolute path or `file://` URL. */
  wikiDir?: string;
  /**
   * A publish for reviewers (`publishToTeam.ts`): pages with `export: false`
   * and everything under them are left out, and person fields are stripped,
   * as the static export does (`staticExport/visibility.ts`).
   */
  publish?: boolean;
}

export interface LocalWikiExport {
  pages: ImportPage[];
  /** Each imported editor page's file text, by localId. Not sent with `pages_import`. */
  editorFiles: Map<string, { documentType: string; text: string }>;
  /** Files each markdown page links to that are not pages, by localId. */
  linkedFiles: Map<string, LinkedFile[]>;
  /** The wiki folder relative to the project root, and its absolute path; see CollectOptions. */
  wikiPrefix: string;
  wikiDir: string | null;
  types: ImportType[];
  /** Every exported type that has pages or a table, placed where its table is, else at the top. */
  typePlacements: ImportTypePlacement[];
  skipped: SkippedPage[];
  /** The page the banner goes on: the root page titled Home, else the first root page. */
  homeLocalId: string | null;
  /** The root page titled Home, which becomes the team project's Home page. */
  projectHomeLocalId: string | null;
  locations: Map<string, PageLocation>;
  /**
   * Relationship field values by page, as local ids. They are left out of each
   * page's `fields` and sent once every target has its team id.
   */
  relations: Map<string, Record<string, string | string[]>>;
  /** Person fields left out (publish only). */
  strippedFields: number;
  /**
   * Publish only: page files whose frontmatter does not parse (wiki-relative
   * paths) and table types whose file does not parse. They are left out, and
   * their team copies are not removed: the scanner gives a malformed page a
   * derived id, so its real id is unknown until the file is fixed.
   */
  malformed: { paths: string[]; tableTypes: string[] };
}

/** A stored relationship value as local ids: an id, a list of ids, or `{ itemId }` forms of either. */
function relationIds(value: unknown): string | string[] | undefined {
  const one = (v: unknown) => (typeof v === 'string' && v ? v : v && typeof v === 'object' && typeof (v as { itemId?: unknown }).itemId === 'string' ? (v as { itemId: string }).itemId : undefined);
  if (Array.isArray(value)) return value.map(one).filter((id): id is string => Boolean(id));
  return one(value);
}

function splitRelations(
  fields: Record<string, unknown>,
  relationFields: Set<string> | undefined,
): { fields: Record<string, unknown>; relations: Record<string, string | string[]> } {
  const plain: Record<string, unknown> = {};
  const relations: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!relationFields?.has(key)) plain[key] = value;
    else {
      const ids = relationIds(value);
      if (ids !== undefined && (!Array.isArray(ids) || ids.length)) relations[key] = ids;
    }
  }
  return { fields: plain, relations };
}

export const MIGRATION_BANNER_PREFIX = 'This wiki moved to the team project:';

export const migrationBanner = (link: string) => `${MIGRATION_BANNER_PREFIX} ${link}`;

/** The body without the banner a previous move put on top, so a re-run imports what the user wrote. */
export function stripMigrationBanner(body: string): string {
  const lines = body.split('\n');
  if (!lines[0]?.startsWith(MIGRATION_BANNER_PREFIX)) return body;
  let at = 1;
  while (at < lines.length && lines[at].trim() === '') at++;
  return lines.slice(at).join('\n');
}

function readTypeDefinition(file: string): unknown {
  try {
    return yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.CORE_SCHEMA }) ?? null;
  } catch {
    return null;
  }
}

function editorSkipReason(page: LocalPage, editorTypes: CollectOptions['editorTypes']): string | null {
  if (page.documentType === 'markdown') return null;
  if (!EDITOR_IDS[page.documentType]) return `${page.documentType} page (no team editor for this type)`;
  if (!editorTypes) return `${page.documentType} page (the editors' document code is not available)`;
  if ('unavailable' in editorTypes) return `${page.documentType} page (${editorTypes.unavailable})`;
  return editorTypes.has(page.documentType) ? null : `${page.documentType} page (no team import for this type)`;
}

export async function collectLocalWiki(wiki: LocalWiki, options: CollectOptions = {}): Promise<LocalWikiExport> {
  const snapshot = await wiki.snapshot();
  const live = livePages(snapshot);
  const byId = new Map(live.map((page) => [page.id, page]));
  const skipped: SkippedPage[] = [];
  const skipReasons = new Map(live.map((page) => [page.id, editorSkipReason(page, options.editorTypes)]));
  // A publish leaves out `export: false` pages and everything under them; a move takes the whole wiki.
  const hidden = new Set<string>();
  if (options.publish) {
    const hiddenAbove = (page: LocalPage): boolean => {
      const seen = new Set<string>();
      for (let at: LocalPage | undefined = page; at && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
        seen.add(at.id);
        if (isExportOptOut(at.fields)) return true;
      }
      return false;
    };
    for (const page of live) {
      if (!hiddenAbove(page)) continue;
      hidden.add(page.id);
      skipReasons.set(page.id, isExportOptOut(page.fields) ? 'export: false' : 'under a page with export: false');
    }
  }
  const malformedPaths: string[] = [];
  const malformedTables = new Set<string>();
  if (options.publish) {
    for (const page of live) {
      if (!page.malformed || hidden.has(page.id)) continue;
      skipReasons.set(page.id, 'its frontmatter does not parse; fix the file and publish again');
      if (page.path) malformedPaths.push(page.path);
    }
    for (const table of snapshot.tables ?? []) if (table.malformed) malformedTables.add(table.typeId);
  }
  const included = (page: LocalPage) => skipReasons.get(page.id) === null;
  for (const page of live) {
    const reason = skipReasons.get(page.id);
    if (reason) skipped.push({ localId: page.id, title: page.title, reason, ...(hidden.has(page.id) ? { excluded: true as const } : {}) });
  }

  /** The nearest ancestor that is imported; a skipped editor page passes its children up. */
  const importedParent = (parentId: string | null): string | null => {
    const seen = new Set<string>();
    let at = parentId;
    while (at && !seen.has(at)) {
      seen.add(at);
      const parent = byId.get(at);
      if (!parent) return null;
      if (included(parent)) return parent.id;
      at = parent.parentId;
    }
    return null;
  };

  const pages: ImportPage[] = [];
  const editorFiles = new Map<string, { documentType: string; text: string }>();
  const linkedFiles = new Map<string, LinkedFile[]>();
  /** Every page file, imported or not: a link to one is a page link, never a file to upload. */
  const pagePaths = new Set(live.flatMap((page) => (page.path ? [page.path.toLowerCase()] : [])));
  const locations = new Map<string, PageLocation>();
  const usedTypes = new Set<string>();
  const relationFieldsByType = new Map(
    wiki.typeDefs().map((def) => [def.typeId, new Set(def.fields.filter((f) => f.type === 'relationship').map((f) => f.name))]),
  );
  const relations = new Map<string, Record<string, string | string[]>>();
  /** Table types, placed where the table sits in the local tree. */
  const tablePlacements = new Map<string, ImportTypePlacement>();
  const userFieldsByType = new Map(
    wiki.typeDefs().map((def) => [def.typeId, new Set(def.fields.filter((f) => f.type === 'user').map((f) => f.name))]),
  );
  let strippedFields = 0;
  const withFields = (localId: string, typeId: string | null, all: Record<string, unknown>) => {
    let fields = all;
    if (options.publish) {
      const { export: _optOut, ...rest } = all;
      const stripped = stripIdentity(rest, (typeId ? userFieldsByType.get(typeId) : undefined) ?? new Set());
      strippedFields += stripped.removed;
      fields = stripped.fields;
    }
    const split = splitRelations(fields, typeId ? relationFieldsByType.get(typeId) : undefined);
    // A relation to a page the publish leaves out is dropped, not reported as a target that failed.
    if (hidden.size) {
      for (const [key, value] of Object.entries(split.relations)) {
        const kept = Array.isArray(value) ? value.filter((id) => !hidden.has(id)) : hidden.has(value) ? undefined : value;
        if (kept === undefined || (Array.isArray(kept) && !kept.length)) delete split.relations[key];
        else split.relations[key] = kept;
      }
    }
    if (Object.keys(split.relations).length) relations.set(localId, split.relations);
    return Object.keys(split.fields).length ? { fields: split.fields } : {};
  };
  for (const node of buildTree(snapshot)) {
    if (node.kind === 'type') {
      const tableParent = node.parentNodeId ? node.parentNodeId.replace(/^(document|item):/, '') : null;
      // A table under a page the publish leaves out goes with it.
      if (tableParent && hidden.has(tableParent)) continue;
      if (malformedTables.has(node.id)) {
        skipped.push({ localId: `type:${node.id}`, title: node.id, reason: 'its table file does not parse; fix the file and publish again' });
        continue;
      }
      const tracker = await wiki.trackerSnapshot(node.id);
      const parentLocalId = importedParent(tableParent);
      usedTypes.add(node.id);
      tablePlacements.set(node.id, { typeId: node.id, parentLocalId, ...(node.sortOrder !== null ? { order: node.sortOrder } : {}) });
      tracker.items.forEach((item, index) => {
        pages.push({
          localId: item.id,
          parentLocalId,
          title: item.title,
          order: item.order ?? (index + 1) * 1000,
          kind: 'typedPage',
          typeId: node.id,
          underType: true,
          ...withFields(item.id, node.id, item.fields),
          body: '',
        });
      });
      continue;
    }
    const page = byId.get(node.id);
    if (!page || !included(page)) continue;
    const { markdown } = await wiki.readBody(page.id);
    locations.set(page.id, { path: page.path, dir: page.dir });
    if (page.documentType !== 'markdown') {
      editorFiles.set(page.id, { documentType: page.documentType, text: markdown });
      pages.push({
        localId: page.id,
        parentLocalId: importedParent(page.parentId),
        title: page.title,
        ...(page.order !== null ? { order: page.order } : {}),
        kind: 'editorPage',
        documentType: page.documentType,
        fileExtension: page.fileExtension,
        editorId: EDITOR_IDS[page.documentType],
        ...withFields(page.id, null, page.fields),
        body: '',
      });
      continue;
    }
    const files = await linkedFilesOf(wiki, page.id, markdown, { path: page.path, dir: page.dir }, pagePaths);
    if (files.length) linkedFiles.set(page.id, files);
    if (page.type) usedTypes.add(page.type);
    pages.push({
      localId: page.id,
      parentLocalId: importedParent(page.parentId),
      title: page.title,
      ...(page.order !== null ? { order: page.order } : {}),
      kind: page.type ? 'typedPage' : 'page',
      ...(page.type ? { typeId: page.type } : {}),
      ...withFields(page.id, page.type, page.fields),
      body: stripMigrationBanner(markdown),
    });
  }

  const types: ImportType[] = [];
  for (const def of wiki.typeDefs()) {
    if (!usedTypes.has(def.typeId) && !def.wikiType) continue;
    types.push({ id: def.typeId, name: def.displayName, definition: readTypeDefinition(def.sourcePath) });
  }

  // A type used only by typed pages has no tree node locally; in the team it needs one to show, so it goes at the top.
  const typePlacements = types
    .filter((type) => usedTypes.has(type.id))
    .map((type) => tablePlacements.get(type.id) ?? { typeId: type.id, parentLocalId: null });

  const roots = pages.filter((page) => page.parentLocalId === null && page.kind === 'page');
  const projectHome = roots.find((page) => page.title.trim().toLowerCase() === 'home') ?? null;
  const home = projectHome ?? roots[0] ?? null;
  return {
    pages,
    editorFiles,
    linkedFiles,
    wikiPrefix: options.wikiPrefix ?? '',
    wikiDir: options.wikiDir ?? null,
    types,
    typePlacements,
    skipped,
    homeLocalId: home?.localId ?? null,
    projectHomeLocalId: projectHome?.localId ?? null,
    locations,
    relations,
    strippedFields,
    malformed: { paths: malformedPaths, tableTypes: [...malformedTables] },
  };
}

/**
 * The non-page files a body links to, once each: images and attachments the
 * move uploads. A link to an editor page's file is a page link, not a file,
 * and is left to the page link rewrite.
 */
async function linkedFilesOf(wiki: LocalWiki, pageId: string, body: string, from: PageLocation, pagePaths: ReadonlySet<string>): Promise<LinkedFile[]> {
  const linkPaths = new Set<string>();
  rewriteFileLinks(body, (linkPath) => {
    const resolved = resolveRelative(linkBase(from), linkPath);
    if (resolved === null || !pagePaths.has(resolved)) linkPaths.add(linkPath);
    return null;
  });
  const files: LinkedFile[] = [];
  for (const linkPath of linkPaths) files.push({ linkPath, abs: await wiki.resolvePageFile(pageId, linkPath) });
  return files;
}

/** Wiki-relative folder a page's links are written relative to (see FORMAT.md, Links). */
function linkBase(location: PageLocation): string {
  return location.path ? path.posix.dirname(location.path).replace(/^\.$/, '') : location.dir;
}

function resolveRelative(base: string, linkPath: string): string | null {
  const joined = path.posix.normalize(path.posix.join(base === '' ? '.' : base, linkPath));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return null;
  return (joined === '.' ? '' : joined).replace(/\/$/, '').toLowerCase();
}

/** Lowercased wiki-relative page file and folder paths to page ids, for links written without an id. */
export function pathIndex(locations: Map<string, PageLocation>): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const [id, location] of locations) {
    byPath.set(location.dir.toLowerCase(), id);
    if (location.path) byPath.set(location.path.toLowerCase(), id);
  }
  return byPath;
}

/**
 * Rewrites every link to another wiki page into its team link: by the link's
 * `id=` title first, else by its relative path. Links to pages the move did
 * not import (an editor page, a page that failed) are left as written.
 */
export function rewriteWikiLinks(
  body: string,
  from: PageLocation,
  byPath: Map<string, string>,
  linkFor: (localId: string) => string | undefined,
): { body: string; rewritten: number } {
  const links = findLinks(body).filter((link) => link.isPageLink);
  let out = '';
  let cursor = 0;
  let rewritten = 0;
  for (const link of links) {
    let href = link.id ? linkFor(link.id) : undefined;
    if (!href && link.path) {
      const resolved = resolveRelative(linkBase(from), link.path);
      const targetId = resolved === null ? undefined : byPath.get(resolved);
      if (targetId) href = linkFor(targetId);
    }
    if (!href) continue;
    out += body.slice(cursor, link.start) + `[${link.text}](${href}${link.fragment})`;
    cursor = link.end;
    rewritten++;
  }
  return rewritten ? { body: out + body.slice(cursor), rewritten } : { body, rewritten: 0 };
}

/**
 * Rewrites file links (no `id=`, not to a `.md` page) for the team wiki: one to
 * a file the move uploaded becomes its asset uri, and one to an editor page's
 * file becomes that page's team link. Anything else is left as written.
 */
export function rewriteFileLinksForTeam(
  body: string,
  from: PageLocation,
  byPath: Map<string, string>,
  linkFor: (localId: string) => string | undefined,
  assetUri: (linkPath: string) => string | undefined,
): { body: string; rewritten: number } {
  let rewritten = 0;
  const next = rewriteFileLinks(body, (linkPath) => {
    const resolved = resolveRelative(linkBase(from), linkPath);
    const targetId = resolved === null ? undefined : byPath.get(resolved);
    const href = assetUri(linkPath) ?? (targetId ? linkFor(targetId) : undefined);
    if (href) rewritten++;
    return href ?? null;
  }, { raw: true });
  return { body: next, rewritten };
}

/** A link alone on its line, which the editor renders as an embed when it names an editor page. */
const BLOCK_LINK = /^([ \t]*)\[((?:[^[\]\\\n]|\\.)*)\]\([ \t]*(<[^<>\n]*>|[^\s()<>]+)(?:[ \t]+"((?:[^"\\\n]|\\.)*)")?[ \t]*\)([ \t]*)$/;
/** `key=value` pairs of an embed link's title, as `parseEmbedAttrs` in the runtime reads them. */
const TITLE_ATTR = /([A-Za-z_][A-Za-z0-9_-]*)=(?:"[^"]*"|'[^']*'|\S+)/g;

/** A team embed: the page's `nimbalyst://doc` link and the file extension its title names as `embedType`. */
export interface TeamEmbed {
  uri: string;
  fileExtension: string;
}

/**
 * Rewrites each embed (a link to an editor page alone on its line, outside
 * code fences) into the form a team page embeds, as the desktop's share
 * writes it (`rewriteEmbeddedDocumentLinks`): the page's `nimbalyst://doc`
 * link with `embedType` added to the title's size and other attributes. A
 * link opted out with `embed=false`, or to a page with no team embed, is left
 * for the link rewrites.
 */
export function rewriteEmbedsForTeam(
  body: string,
  from: PageLocation,
  byPath: Map<string, string>,
  embedFor: (localId: string) => TeamEmbed | undefined,
): { body: string; rewritten: number } {
  const parts = body.split(/(\r?\n)/);
  let fence: string | null = null;
  let rewritten = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const match = BLOCK_LINK.exec(line);
    if (!match) continue;
    const [, leading, label, rawDest, title = '', trailing] = match;
    const attrs = [...title.matchAll(TITLE_ATTR)].map(([pair, key]) => ({ key, pair }));
    if (attrs.some(({ pair }) => pair === 'embed=false')) continue;
    const dest = rawDest.startsWith('<') ? rawDest.slice(1, -1) : rawDest;
    const pathPart = dest.split('#')[0];
    let targetId = attrs.find(({ key }) => key === 'id')?.pair.slice(3);
    if (!targetId && pathPart && !/^[a-z][a-z0-9+.-]*:/i.test(pathPart) && !pathPart.startsWith('/')) {
      let decoded = pathPart;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {
        // A malformed escape is matched as written.
      }
      const resolved = resolveRelative(linkBase(from), decoded);
      targetId = resolved === null ? undefined : byPath.get(resolved);
    }
    const embed = targetId ? embedFor(targetId) : undefined;
    if (!embed) continue;
    const kept = attrs.filter(({ key }) => key !== 'id' && key !== 'embedType').map(({ pair }) => pair);
    parts[i] = `${leading}[${label}](${embed.uri} "${[...kept, `embedType=${embed.fileExtension}`].join(' ')}")${trailing}`;
    rewritten++;
  }
  return rewritten ? { body: parts.join(''), rewritten } : { body, rewritten: 0 };
}

const HTML_HREF = /(\bhref\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Points each relative `href` in an HTML page that names a page of this wiki
 * at that page's team link, keeping its `#fragment`. In a team the HTML page
 * resolves a relative link by page titles, which local file names do not
 * match. Web links, in-page anchors and links to no imported page are left
 * as written.
 */
export function rewriteHtmlPageLinks(
  html: string,
  from: PageLocation,
  byPath: Map<string, string>,
  linkFor: (localId: string) => string | undefined,
): { text: string; rewritten: number } {
  let rewritten = 0;
  const text = html.replace(HTML_HREF, (whole, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
    const href = doubleQuoted ?? singleQuoted ?? '';
    if (!href || href.startsWith('#') || href.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return whole;
    const hash = href.indexOf('#');
    const pathPart = href.split(/[?#]/)[0];
    let decoded = pathPart;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      return whole;
    }
    const resolved = resolveRelative(linkBase(from), decoded);
    const targetId = resolved === null ? undefined : byPath.get(resolved);
    const link = targetId ? linkFor(targetId) : undefined;
    if (!link) return whole;
    rewritten++;
    const quote = doubleQuoted !== undefined ? '"' : "'";
    return `${prefix}${quote}${link}${hash >= 0 ? href.slice(hash) : ''}${quote}`;
  });
  return { text, rewritten };
}

/** `NIMBALYST_CANVAS_NAMESPACE` in `packages/runtime/src/canvas/CanvasDocument.ts`, which nim does not bundle. */
const CANVAS_NAMESPACE = 'x-nimbalyst';

/**
 * A canvas card's file path as a wiki-relative path, by the desktop's rule
 * (`resolveCanvasFilePath`): an absolute path or `file://` URL as it is, `./`
 * and `../` from the canvas's folder, otherwise from the project root. Null
 * for anything outside the wiki.
 */
function canvasCardTarget(href: string, canvasPath: string, wikiPrefix: string, wikiDir: string | null): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) return null;
  let decoded = href.split('?')[0].split('#')[0].replace(/^file:\/\//i, '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }
  if (!decoded) return null;
  if (path.isAbsolute(decoded)) {
    if (!wikiDir) return null;
    const rel = path.relative(wikiDir, path.normalize(decoded));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/').toLowerCase();
  }
  if (decoded.startsWith('./') || decoded.startsWith('../')) return resolveRelative(path.posix.dirname(canvasPath).replace(/^\.$/, ''), decoded);
  const fromRoot = path.posix.normalize(decoded);
  if (!wikiPrefix) return resolveRelative('', fromRoot);
  return fromRoot.startsWith(`${wikiPrefix}/`) ? resolveRelative('', fromRoot.slice(wikiPrefix.length + 1)) : null;
}

/**
 * Canvas file cards that show a page of this wiki get `sharedAs` pointing at
 * that page's team document, as the desktop's share does
 * (`rewriteCanvasEmbeddedDocuments`); the card keeps its local path. A canvas
 * with no such card is returned as written.
 */
export function shareCanvasCards(
  text: string,
  canvasPath: string,
  wiki: { prefix: string; dir: string | null },
  byPath: Map<string, string>,
  teamDocument: (localId: string) => { orgId: string; documentId: string } | undefined,
): { text: string; shared: number } {
  let canvas: { nodes?: Array<Record<string, any>> };
  try {
    canvas = JSON.parse(text);
  } catch {
    return { text, shared: 0 };
  }
  if (!Array.isArray(canvas?.nodes)) return { text, shared: 0 };
  let shared = 0;
  const nodes = canvas.nodes.map((node) => {
    const extension = node?.[CANVAS_NAMESPACE] ?? {};
    const reference = extension.reference;
    const href = reference?.kind === 'file' ? reference.path : node?.type === 'file' && typeof node.file === 'string' ? node.file : null;
    if (typeof href !== 'string') return node;
    const target = canvasCardTarget(href, canvasPath, wiki.prefix, wiki.dir);
    const localId = target === null ? undefined : byPath.get(target);
    const doc = localId ? teamDocument(localId) : undefined;
    if (!doc) return node;
    shared++;
    const uri = `nimbalyst://doc/${encodeURIComponent(doc.orgId)}/${encodeURIComponent(doc.documentId)}`;
    const fileReference = reference?.kind === 'file' ? reference : { kind: 'file', path: href };
    return { ...node, [CANVAS_NAMESPACE]: { ...extension, reference: { ...fileReference, sharedAs: { uri } } } };
  });
  return shared ? { text: JSON.stringify({ ...canvas, nodes }, null, 2), shared } : { text, shared: 0 };
}
