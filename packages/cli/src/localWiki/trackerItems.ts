/**
 * Typed items in the local wiki (typed pages and table rows), shared by
 * `nim mcp`'s tracker tools and `nim tracker` for wiki types.
 */
import type { LocalTrackerItem, LocalWiki } from '@nimbalyst/local-wiki';
import { notFoundError, usageError } from '../cli/exitCodes.js';
import { TERMINAL_STATUSES } from '../gateway/schema.js';
import { localPageUri } from './tree.js';

/** Types declared as wiki types: their YAML in .nimbalyst/trackers says `storage: pages|table`. */
export function declaredWikiTypes(wiki: LocalWiki): string[] {
  return wiki.typeDefs().filter((def) => def.wikiType).map((def) => def.typeId).sort();
}

/** Types the wiki holds or may hold: declared wiki types, plus any type with items already in it. */
export async function wikiTypes(wiki: LocalWiki): Promise<string[]> {
  const ids = new Set(declaredWikiTypes(wiki));
  for (const id of await placedTypes(wiki)) ids.add(id);
  return [...ids].sort();
}

/**
 * Types that already have items in the wiki: a table type's CSV, or a live
 * typed page, whether or not the type is declared a wiki type.
 */
export async function placedTypes(wiki: LocalWiki): Promise<string[]> {
  const snapshot = await wiki.snapshot();
  const ids = new Set(snapshot.tables.map((table) => table.typeId));
  for (const page of snapshot.pages) if (page.type && page.trashedAt === null) ids.add(page.type);
  return [...ids].sort();
}

export async function allItems(wiki: LocalWiki, type?: string): Promise<LocalTrackerItem[]> {
  const types = type ? [type] : await wikiTypes(wiki);
  const out: LocalTrackerItem[] = [];
  for (const typeId of types) out.push(...(await wiki.trackerSnapshot(typeId)).items);
  return out;
}

export async function findLocalItem(wiki: LocalWiki, id: string): Promise<LocalTrackerItem | null> {
  return (await allItems(wiki)).find((candidate) => candidate.id === id) ?? null;
}

export async function findItem(wiki: LocalWiki, id: string): Promise<LocalTrackerItem> {
  const item = await findLocalItem(wiki, id);
  if (!item) throw notFoundError(`No typed page or table row ${id} in the local wiki`);
  return item;
}

export const text = (value: unknown) => (value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value));

export interface WhereFilter {
  field?: unknown;
  op?: unknown;
  value?: unknown;
}

function matchesWhere(item: LocalTrackerItem, clause: WhereFilter): boolean {
  const field = String(clause.field ?? '');
  const raw = field === 'title' ? item.title : item.fields[field];
  const values = Array.isArray(raw) ? raw.map(text) : [text(raw)];
  const wanted = clause.value;
  const list = Array.isArray(wanted) ? wanted.map(text) : [text(wanted)];
  const lower = (s: string) => s.toLowerCase();
  const num = Number(text(raw));
  switch (clause.op) {
    case '=':
      return values.some((v) => lower(v) === lower(text(wanted)));
    case '!=':
      return !values.some((v) => lower(v) === lower(text(wanted)));
    case 'contains':
      return values.some((v) => lower(v).includes(lower(text(wanted))));
    case 'not-contains':
      return !values.some((v) => lower(v).includes(lower(text(wanted))));
    case 'in':
      return values.some((v) => list.map(lower).includes(lower(v)));
    case 'not-in':
      return !values.some((v) => list.map(lower).includes(lower(v)));
    case 'is-empty':
      return values.every((v) => v === '');
    case 'is-not-empty':
      return values.some((v) => v !== '');
    case '>':
      return num > Number(wanted);
    case '>=':
      return num >= Number(wanted);
    case '<':
      return num < Number(wanted);
    case '<=':
      return num <= Number(wanted);
    case 'between':
      return Array.isArray(wanted) && num >= Number(wanted[0]) && num <= Number(wanted[1]);
    default:
      throw usageError(`Unknown where op ${String(clause.op)}`);
  }
}

export interface ItemFilter {
  type?: string;
  /** An explicit status, or 'open' / 'closed'. Default: open only, unless includeClosed. */
  status?: string;
  includeClosed?: boolean;
  priority?: string;
  owner?: string;
  search?: string;
  where?: WhereFilter[];
  whereCombinator?: 'and' | 'or';
}

/** Matching items, most recently updated first. */
export async function listItems(wiki: LocalWiki, filter: ItemFilter): Promise<LocalTrackerItem[]> {
  let items = await allItems(wiki, filter.type);
  const closed = (i: LocalTrackerItem) => TERMINAL_STATUSES.has(text(i.fields.status).toLowerCase());
  if (filter.status === 'open') items = items.filter((i) => !closed(i));
  else if (filter.status === 'closed') items = items.filter(closed);
  else if (filter.status) items = items.filter((i) => text(i.fields.status).toLowerCase() === filter.status!.toLowerCase());
  else if (!filter.includeClosed) items = items.filter((i) => !closed(i));
  for (const key of ['priority', 'owner'] as const) {
    const wanted = filter[key];
    if (wanted) items = items.filter((i) => text(i.fields[key]).toLowerCase() === wanted.toLowerCase());
  }
  const search = filter.search?.toLowerCase();
  if (search) items = items.filter((i) => `${i.title} ${Object.values(i.fields).map(text).join(' ')}`.toLowerCase().includes(search));
  const clauses = filter.where ?? [];
  if (clauses.length) {
    const any = filter.whereCombinator === 'or';
    items = items.filter((i) => (any ? clauses.some((c) => matchesWhere(i, c)) : clauses.every((c) => matchesWhere(i, c))));
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function summarize(item: LocalTrackerItem, full: boolean) {
  const base = {
    id: item.id,
    type: item.type,
    title: item.title,
    status: item.fields.status ?? null,
    priority: item.fields.priority ?? null,
    owner: item.fields.owner ?? null,
    storage: item.storage,
    path: item.path,
    ...(item.storage === 'pages' ? { uri: localPageUri(item.id) } : {}),
    updatedAt: item.updatedAt,
  };
  return full ? { ...base, fields: item.fields, parentId: item.parentId } : base;
}

/**
 * New items go to the wiki only for declared wiki types. Every custom type file
 * loads as a definition, including types whose items live in the app database,
 * so a definition without `storage:` (or no definition) is refused.
 */
export function requireWikiType(wiki: LocalWiki, type: string): void {
  const def = wiki.typeDefs().find((candidate) => candidate.typeId === type);
  if (def?.wikiType) return;
  const declare = `To keep ${type} items in the wiki, add \`storage: pages\` (or \`storage: table\`) to .nimbalyst/trackers/${type}.yaml.`;
  if (def) {
    throw usageError(
      `"${type}" items live in the Nimbalyst app database, not the local wiki. Create it in the app, ` +
        `or with \`nim tracker create ${type} ...\` without --local. ${declare}`,
    );
  }
  const known = declaredWikiTypes(wiki);
  throw usageError(`"${type}" is not a wiki type (${known.length ? `wiki types: ${known.join(', ')}` : 'none declared yet'}). ${declare}`);
}

export async function createItem(
  wiki: LocalWiki,
  type: string,
  input: { title: string; fields: Record<string, unknown>; body?: string; parentId?: string | null },
): Promise<LocalTrackerItem> {
  requireWikiType(wiki, type);
  const { storage } = await wiki.trackerSnapshot(type);
  if (storage === 'table' && input.body) throw usageError(`${type} is a table type; its rows have no body`);
  const result = await wiki.trackerCommand(type, {
    type: 'create-item',
    item: { title: input.title, fields: input.fields, parentId: input.parentId ?? null, body: input.body },
  });
  return findItem(wiki, result.id!);
}

/** Field updates (null clears one; `title` renames), and for a typed page a new body or type. */
export async function updateItem(
  wiki: LocalWiki,
  id: string,
  input: { updates: Record<string, unknown>; body?: string; primaryType?: string },
): Promise<LocalTrackerItem> {
  const item = await findItem(wiki, id);
  if (item.storage === 'table' && (input.body !== undefined || input.primaryType)) {
    throw usageError(`${item.type} is a table type; its rows have no body and cannot change type`);
  }
  if (Object.keys(input.updates).length) {
    await wiki.trackerCommand(item.type, { type: 'update-item', input: { itemId: item.id, updates: input.updates } });
  }
  if (input.body !== undefined) {
    const written = await wiki.writeBody(item.id, input.body, null);
    if (!written.ok) throw usageError('the body changed while writing; read it again');
  }
  if (input.primaryType && input.primaryType !== item.type) {
    await wiki.command({ type: 'set-document-type', documentId: item.id, pageType: input.primaryType });
  }
  return findItem(wiki, item.id);
}
