/**
 * Decision and open-question marks across the pages this device can read
 * locally: typed pages (tracker item bodies, including teammates' edits once
 * the remote body indexer has cached them), Personal pages and Personal type
 * pages, and the Local wiki's page files. Plain team pages and team type pages live only in their rooms; the
 * renderer adds them from the server's marks index (`desktopPageMarksSource`).
 *
 * Bodies are read on demand and parsed with the same scanner the editor uses
 * (`pageMarkSyntax`), so there is no second store to keep in step. A LIKE
 * prefilter keeps the parse to bodies that can hold a mark.
 *
 * One SQL string runs on both backends: `CAST(... AS TEXT)` reads PGLite's
 * JSONB `content` and SQLite's TEXT column alike, and booleans and JSON are
 * normalized in JS.
 */
import { findPageMarks } from '@nimbalyst/runtime/core/pageMarkSyntax';
import type { PageMarkRecord, PageMarksQuery } from '@nimbalyst/collab-client/pages';
import { filterPageMarks } from '@nimbalyst/collab-client/pages';

import { bodyMarkdownOf } from '../tracker/trackerBodyLinks';

export interface PageMarksDb {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

const TYPE_PAGE_PREFIX = 'type-page:';
const MARK_PATTERNS = ['%]{decided%', '%]{open%'];

function rowsOf(result: unknown): any[] {
  const r = result as { rows?: unknown[] } | undefined;
  return Array.isArray(r?.rows) ? (r!.rows as any[]) : [];
}

function parseJson(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}

export function marksIn(
  markdown: string,
  page: PageMarkRecord['page'],
): PageMarkRecord[] {
  return findPageMarks(markdown).map((mark) => ({
    id: `${page.uri}#${mark.start}`,
    kind: mark.kind,
    text: mark.text,
    plainText: mark.plainText,
    by: mark.by ?? null,
    email: mark.email ?? null,
    on: mark.on ?? null,
    over: mark.over ?? null,
    line: mark.line,
    page,
  }));
}

async function typedPageMarks(db: PageMarksDb, workspacePath: string): Promise<PageMarkRecord[]> {
  // The newest cached room body wins when it is at least as new as the row:
  // a teammate's edit lands in the cache, a local save lands in `content`.
  const rows = rowsOf(await db.query(
    `SELECT t.id, t.type, t.issue_key, t.data, t.content, t.body_version, t.archived, t.sync_status,
            c.content AS cached_content, c.body_version AS cached_version
     FROM tracker_items t
     LEFT JOIN tracker_body_cache c
       ON c.item_id = t.id
      AND c.body_version = (SELECT MAX(body_version) FROM tracker_body_cache WHERE item_id = t.id)
     WHERE t.workspace = $1 AND t.deleted_at IS NULL
       AND (CAST(t.content AS TEXT) LIKE $2 OR CAST(t.content AS TEXT) LIKE $3
            OR CAST(c.content AS TEXT) LIKE $2 OR CAST(c.content AS TEXT) LIKE $3)`,
    [workspacePath, ...MARK_PATTERNS],
  ));
  const out: PageMarkRecord[] = [];
  for (const row of rows) {
    if (isTrue(row.archived)) continue;
    const useCache = row.cached_content != null && Number(row.cached_version ?? 0) >= Number(row.body_version ?? 0);
    const markdown = bodyMarkdownOf(useCache ? row.cached_content : row.content);
    if (!markdown) continue;
    const data = parseJson(row.data) ?? {};
    out.push(...marksIn(markdown, {
      kind: 'typed-page',
      scope: row.sync_status && row.sync_status !== 'local' ? 'team' : 'personal',
      id: String(row.id),
      title: typeof data.title === 'string' ? data.title : String(row.id),
      uri: `tracker://${row.id}`,
      typeId: typeof row.type === 'string' ? row.type : null,
      issueKey: typeof row.issue_key === 'string' ? row.issue_key : null,
    }));
  }
  return out;
}

async function personalPageMarks(db: PageMarksDb, workspacePath: string): Promise<PageMarkRecord[]> {
  const rows = rowsOf(await db.query(
    `SELECT document_id, title, body FROM personal_page_documents
     WHERE workspace_path = $1 AND trashed_at IS NULL AND (body LIKE $2 OR body LIKE $3)`,
    [workspacePath, ...MARK_PATTERNS],
  ));
  const out: PageMarkRecord[] = [];
  for (const row of rows) {
    const documentId = String(row.document_id);
    const typeId = documentId.startsWith(TYPE_PAGE_PREFIX) ? documentId.slice(TYPE_PAGE_PREFIX.length) : null;
    out.push(...marksIn(typeof row.body === 'string' ? row.body : '', {
      kind: typeId ? 'type-page' : 'personal-page',
      scope: 'personal',
      id: documentId,
      title: typeof row.title === 'string' ? row.title : documentId,
      uri: typeId ? `type://${typeId}` : `personal://${documentId}`,
      typeId,
      issueKey: null,
    }));
  }
  return out;
}

/**
 * Every mark in the workspace's readable pages that matches `query`.
 * `localWikiMarks` adds the Local wiki's files; a page exported to the wiki
 * keeps its database row with the same id, and the file wins.
 */
export async function queryPageMarks(
  db: PageMarksDb,
  workspacePath: string,
  query: PageMarksQuery = {},
  localWikiMarks?: () => Promise<PageMarkRecord[]>,
): Promise<PageMarkRecord[]> {
  const wiki = localWikiMarks ? await localWikiMarks() : [];
  const inWiki = new Set(wiki.map((record) => record.page.id));
  const records = [
    ...(await typedPageMarks(db, workspacePath)).filter((record) => !inWiki.has(record.page.id)),
    ...(await personalPageMarks(db, workspacePath)).filter((record) => !inWiki.has(record.page.id)),
    ...wiki,
  ];
  return filterPageMarks(records, query);
}
