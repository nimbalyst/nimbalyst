/**
 * `nim tracker list/get/show/create/update` for types placed in the project's
 * local wiki, through `@nimbalyst/local-wiki`. Everything else keeps using the
 * app database gateways, unchanged.
 *
 * A call goes to the wiki when `--local` is given, or when the project has a
 * local wiki and the call names a wiki type or something already in it: a type
 * declared with `storage: pages|table` (list and create), a type that already
 * has items in the wiki (list), or the id of a typed page or table row there
 * (get, show, update).
 */
import type { LocalTrackerItem } from '@nimbalyst/local-wiki';
import type { ParsedArgs } from '../cli/parse.js';
import { flagBool, flagInt, flagList, flagStr } from '../cli/parse.js';
import { notFoundError, usageError } from '../cli/exitCodes.js';
import { dim, green } from '../cli/colors.js';
import { hasLocalWiki, openLocalWiki } from '../localWiki/open.js';
import { createItem, declaredWikiTypes, findLocalItem, listItems, placedTypes, summarize, updateItem, type WhereFilter } from '../localWiki/trackerItems.js';
import { parseFields, parseWhere, readBody } from './common.js';

type Wiki = Awaited<ReturnType<typeof openLocalWiki>>['wiki'];

const ROUTED_VERBS = new Set(['list', 'get', 'show', 'create', 'update']);
/** Local wiki ids are ULIDs; anything else (issue keys, urns) is never a wiki item. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Runs the verb against the local wiki when it belongs there and returns its
 * exit code, or returns null to let the database gateways handle it.
 */
export async function runLocalTracker(args: ParsedArgs): Promise<number | null> {
  if (!args.verb || !ROUTED_VERBS.has(args.verb)) return null;
  const forced = flagBool(args, 'local');
  if (!forced && (flagStr(args, 'db') || flagBool(args, 'offline') || flagBool(args, 'live'))) return null;
  const startDir = flagStr(args, 'workspace') ?? process.cwd();
  const location = flagStr(args, 'location');
  if (!forced && !hasLocalWiki(startDir, location)) return null;

  const isListOrCreate = args.verb === 'list' || args.verb === 'create';
  const type = args.verb === 'list' ? flagStr(args, 'type') : args.verb === 'create' ? args.positionals[0] : undefined;
  const ref = isListOrCreate ? undefined : args.positionals[0];
  // Cheap checks before scanning the wiki: nothing here can be a wiki item.
  if (!forced && (isListOrCreate ? !type : !ref || !ULID.test(ref))) return null;

  const { wiki } = await openLocalWiki(startDir, location);
  try {
    if (!forced) {
      // Declared wiki types route from their first item; undeclared types only to read or
      // update typed pages already in the wiki (creating one is refused, see requireWikiType).
      const inWiki =
        args.verb === 'create'
          ? declaredWikiTypes(wiki).includes(type!)
          : args.verb === 'list'
            ? declaredWikiTypes(wiki).includes(type!) || (await placedTypes(wiki)).includes(type!)
            : (await findLocalItem(wiki, ref!)) !== null;
      if (!inWiki) return null;
    }
    switch (args.verb) {
      case 'list':
        return await list(args, wiki);
      case 'create':
        return await create(args, wiki);
      case 'update':
        return await update(args, wiki);
      default:
        return await get(args, wiki);
    }
  } finally {
    wiki.close();
  }
}

const json = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

/** `--status`, `--priority`, `--owner`, `--tag` and `--field k=v` as one field patch. */
function fieldPatch(args: ParsedArgs): Record<string, unknown> {
  const patch = parseFields(flagList(args, 'field'));
  for (const key of ['status', 'priority', 'owner']) {
    const value = flagStr(args, key);
    if (value !== undefined) patch[key] = value;
  }
  const tags = flagList(args, 'tag');
  if (tags.length) patch.tags = tags;
  return patch;
}

function line(item: LocalTrackerItem): string {
  return `${item.id}  ${String(item.fields.status ?? '-').padEnd(12)}  ${item.title}  ${dim(item.type)}`;
}

async function list(args: ParsedArgs, wiki: Wiki): Promise<number> {
  const where: WhereFilter[] = parseWhere(flagList(args, 'where')).map((clause) =>
    clause.op === '~'
      ? { field: clause.field, op: 'contains', value: clause.value }
      : clause.op === 'in'
        ? { field: clause.field, op: 'in', value: clause.value.split(',').map((v) => v.trim()) }
        : clause,
  );
  const items = await listItems(wiki, {
    type: flagStr(args, 'type'),
    status: flagStr(args, 'status'),
    // Like the database gateways: every status unless --status open|closed|<s> narrows it.
    includeClosed: true,
    priority: flagStr(args, 'priority'),
    owner: flagStr(args, 'owner'),
    search: flagStr(args, 'search'),
    where,
  });
  const shown = flagBool(args, 'all') ? items : items.slice(0, flagInt(args, 'limit') ?? 50);
  if (flagBool(args, 'json')) json(shown.map((item) => summarize(item, true)));
  else if (flagBool(args, 'quiet')) process.stdout.write(shown.map((item) => item.id).join('\n') + (shown.length ? '\n' : ''));
  else process.stdout.write(shown.length ? shown.map(line).join('\n') + '\n' : dim('No items.') + '\n');
  return 0;
}

async function get(args: ParsedArgs, wiki: Wiki): Promise<number> {
  const ref = args.positionals[0];
  if (!ref) throw usageError(`'nim tracker ${args.verb}' requires an id.`);
  const item = await findLocalItem(wiki, ref);
  if (!item) throw notFoundError(`No typed page or table row ${ref} in the local wiki`);
  const body = item.storage === 'pages' ? await wiki.readBody(item.id) : null;
  if (flagBool(args, 'json')) {
    json({ ...summarize(item, true), ...(body ? { version: body.version, markdown: body.markdown } : {}) });
    return 0;
  }
  const out = [line(item), ...Object.entries(item.fields).map(([key, value]) => `  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)];
  if (item.path) out.push(dim(`  ${item.path}`));
  if (body?.markdown) out.push('', body.markdown.trimEnd());
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

async function create(args: ParsedArgs, wiki: Wiki): Promise<number> {
  const [type, title] = args.positionals;
  if (!type || !title) throw usageError(`'nim tracker create' requires <type> "<title>".`);
  const parent = flagStr(args, 'parent');
  const item = await createItem(wiki, type, { title, fields: fieldPatch(args), body: readBody(args), parentId: parent ?? null });
  if (flagBool(args, 'json')) json(summarize(item, true));
  else if (flagBool(args, 'quiet')) process.stdout.write(item.id + '\n');
  else process.stdout.write(green(`Created ${item.id}`) + dim(` (${item.type}, ${item.path ?? 'local wiki'})`) + '\n');
  return 0;
}

async function update(args: ParsedArgs, wiki: Wiki): Promise<number> {
  const ref = args.positionals[0];
  if (!ref) throw usageError(`'nim tracker update' requires an id.`);
  const updates = fieldPatch(args);
  for (const name of flagList(args, 'unset')) updates[name] = null;
  const title = flagStr(args, 'title');
  if (title !== undefined) updates.title = title;
  const item = await updateItem(wiki, ref, { updates, body: readBody(args) });
  if (flagBool(args, 'json')) json(summarize(item, true));
  else if (flagBool(args, 'quiet')) process.stdout.write(item.id + '\n');
  else process.stdout.write(green(`Updated ${item.id}`) + '\n');
  return 0;
}
