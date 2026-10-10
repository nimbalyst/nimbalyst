/**
 * `nim wiki ...` on the team wiki (routing in commands/wikiLocal.ts): the team's Nimbalyst Wiki from a shell, through the same
 * Pages tools a terminal agent calls on the sync server's `/mcp` (collab-protocol
 * `pageToolContract.ts`). One verb per tool; `status`, `bind`,
 * `create-project` and `pin` (target resolution and the repo binding) live in
 * pagesProject.ts. The desktop-loopback `nim tracker` commands are a different
 * path and share no code with this one.
 *
 * `pagesToolCall` is pure: argv in, tool name and arguments out, so what each
 * verb sends is tested without a server.
 */
import * as fs from 'node:fs';
import yaml from 'js-yaml';
import type { ParsedArgs } from '../cli/parse.js';
import { flagBool, flagInt, flagList, flagStr } from '../cli/parse.js';
import { usageError } from '../cli/exitCodes.js';
import { safeBlock } from '../cli/output.js';
import { resolveServer } from '../cloud/config.js';
import { field, renderObject, renderRows, type Column } from '../cloud/pagesOutput.js';
import { outputOptions, parseFields, parseWhere, readBody } from './common.js';
import { loadTypeSchema } from './typeSchema.js';
import { print, tool, type PagesCtx } from './pagesCtx.js';
import { runBind, runCreateProject, runPin, runStatus, teamsCtx } from './pagesProject.js';

/** Every verb and the Pages tool it calls. */
export const PAGES_VERBS = {
  status: 'pages_status',
  bind: 'pages_bind_repo',
  'create-project': 'pages_create_project',
  list: 'listPages',
  read: 'readCollabDoc',
  search: 'searchPages',
  edit: 'applyCollabDocEdit',
  create: 'createSharedDoc',
  'create-folder': 'createSharedFolder',
  move: 'moveSharedItem',
  rename: 'renameSharedItem',
  delete: 'deleteSharedItem',
  'set-type': 'setPageType',
  'set-fields': 'setPageFields',
  members: 'findOrgMembers',
  types: 'tracker_list_types',
  'define-type': 'tracker_define_type',
  items: 'tracker_list',
  item: 'tracker_get',
  'create-item': 'tracker_create',
  'update-item': 'tracker_update',
  comments: 'list_citable_inputs',
} as const;

type PagesVerb = keyof typeof PAGES_VERBS;
type ToolVerb = Exclude<PagesVerb, 'status' | 'bind' | 'create-project'>;

export interface PagesToolCall {
  tool: (typeof PAGES_VERBS)[PagesVerb];
  args: Record<string, unknown>;
}

/** The remote server works on team pages only. */
const TEAM = { section: 'team' } as const;

function operandAt(args: ParsedArgs, index: number, what: string): string {
  const value = args.positionals[index];
  if (!value) throw usageError(`'nim wiki ${args.verb}' requires ${what}.`);
  return value;
}

/** Drops undefined values so a call carries only what was given. */
function defined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function parentArgs(args: ParsedArgs, parentKey: 'parentFolderId' | 'newParentFolderId'): Record<string, unknown> {
  return {
    [parentKey]: flagStr(args, 'parent'),
    parentKind: flagStr(args, 'parent-kind'),
    folderPath: flagStr(args, 'path'),
  };
}

function replacements(args: ParsedArgs): Array<{ oldText: string; newText: string }> {
  const file = flagStr(args, 'replacements-file');
  if (file) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err: any) {
      throw usageError(`Could not read --replacements-file "${file}": ${err?.message ?? err}`);
    }
    const valid = Array.isArray(parsed) && parsed.length > 0
      && parsed.every((r: any) => typeof r?.oldText === 'string' && typeof r?.newText === 'string');
    if (!valid) throw usageError(`"${file}" must be a JSON list of { "oldText", "newText" }.`);
    return parsed as Array<{ oldText: string; newText: string }>;
  }
  const olds = flagList(args, 'old');
  const news = flagList(args, 'new');
  if (olds.length === 0) throw usageError(`'nim wiki edit' requires --old TEXT --new TEXT (repeatable) or --replacements-file F.`);
  if (olds.length !== news.length) throw usageError('Pass one --old and one --new per replacement, in the same order.');
  return olds.map((oldText, i) => ({ oldText, newText: news[i]! }));
}

/** `--where` in `nim tracker` syntax, as the tool's `{ field, op, value }`. */
function whereArgs(args: ParsedArgs): unknown[] | undefined {
  const raw = flagList(args, 'where');
  if (raw.length === 0) return undefined;
  return parseWhere(raw).map((clause) => {
    if (clause.op === '~') return { field: clause.field, op: 'contains', value: clause.value };
    if (clause.op === 'in') return { field: clause.field, op: 'in', value: clause.value.split(',').map((v) => v.trim()).filter(Boolean) };
    return clause;
  });
}

/** A predicate registry file: a YAML/JSON list, or an object with `predicates`. */
function loadPredicates(file: string): unknown[] {
  let parsed: any;
  try {
    parsed = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (err: any) {
    throw usageError(`Could not read predicates file "${file}": ${err?.message ?? err}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.predicates;
  if (!Array.isArray(list)) throw usageError(`"${file}" must be a list of predicates or have a top-level "predicates" list.`);
  return list;
}

function itemWriteArgs(args: ParsedArgs): Record<string, unknown> {
  const fields = parseFields(flagList(args, 'field'));
  const tags = flagList(args, 'tag');
  return {
    status: flagStr(args, 'status'),
    priority: flagStr(args, 'priority'),
    owner: flagStr(args, 'owner'),
    fields: Object.keys(fields).length ? fields : undefined,
    tags: tags.length ? tags : undefined,
    description: readBody(args),
  };
}

const BUILDERS: Record<ToolVerb, (args: ParsedArgs) => Record<string, unknown>> = {
  list: () => ({ ...TEAM }),
  read: (args) => ({ filePath: operandAt(args, 0, 'a page uri or link') }),
  edit: (args) => ({ filePath: operandAt(args, 0, 'a page uri or link'), replacements: replacements(args) }),
  create: (args) => ({
    ...TEAM,
    title: operandAt(args, 0, 'a title'),
    ...parentArgs(args, 'parentFolderId'),
    initialContent: readBody(args),
    before: flagStr(args, 'before'),
    after: flagStr(args, 'after'),
  }),
  'create-folder': (args) => ({ ...TEAM, name: operandAt(args, 0, 'a name'), ...parentArgs(args, 'parentFolderId') }),
  move: (args) => {
    const kind = flagStr(args, 'kind');
    if (!kind) throw usageError(`'nim wiki move' requires --kind page|item|type.`);
    return {
      ...TEAM,
      itemId: operandAt(args, 0, 'a page id, typed page key or type id'),
      kind,
      ...parentArgs(args, 'newParentFolderId'),
      before: flagStr(args, 'before'),
      after: flagStr(args, 'after'),
      underType: flagBool(args, 'under-type') || undefined,
    };
  },
  rename: (args) => ({ ...TEAM, itemId: operandAt(args, 0, 'a page id'), newName: operandAt(args, 1, 'a new name') }),
  delete: (args) => {
    const kind = flagStr(args, 'kind');
    if (kind !== 'doc' && kind !== 'folder') {
      throw usageError(`'nim wiki delete' requires --kind doc (a page with no children) or folder (the page and everything under it).`);
    }
    return { ...TEAM, itemId: operandAt(args, 0, 'a page id'), kind };
  },
  'set-type': (args) => ({ ...TEAM, pageId: operandAt(args, 0, 'a page id'), typeId: operandAt(args, 1, 'a type id') }),
  'set-fields': (args) => {
    const fields: Record<string, unknown> = {};
    for (const name of ['owner', 'status', 'summary'] as const) {
      const value = flagStr(args, name);
      if (value !== undefined) fields[name] = value;
    }
    const tags = flagList(args, 'tag');
    if (tags.length) fields.tags = tags;
    for (const name of flagList(args, 'clear')) fields[name] = null;
    if (Object.keys(fields).length === 0) {
      throw usageError(`'nim wiki set-fields' requires --owner, --status, --summary, --tag or --clear <field>.`);
    }
    return { ...TEAM, itemId: operandAt(args, 0, 'a page id'), fields };
  },
  search: (args) => ({ ...TEAM, query: operandAt(args, 0, 'a query'), limit: flagInt(args, 'limit') }),
  members: (args) => ({ query: args.positionals[0] }),
  types: (args) => ({ search: flagStr(args, 'search') }),
  'define-type': (args) => {
    const file = flagStr(args, 'file');
    const predicatesFile = flagStr(args, 'predicates-file');
    const remove = flagList(args, 'remove-predicate');
    if (!file && !predicatesFile && remove.length === 0) {
      throw usageError(`'nim wiki define-type' requires -f <schema.yaml|.json>, --predicates-file <file>, or --remove-predicate <id>.`);
    }
    return {
      schema: file ? loadTypeSchema(file).schema : undefined,
      predicates: predicatesFile ? loadPredicates(predicatesFile) : undefined,
      removePredicates: remove.length ? remove : undefined,
      overwrite: flagBool(args, 'overwrite') || undefined,
      confirmDestructive: flagBool(args, 'confirm-destructive') || undefined,
    };
  },
  items: (args) => ({
    type: flagStr(args, 'type'),
    status: flagStr(args, 'status'),
    owner: flagStr(args, 'owner'),
    search: flagStr(args, 'search'),
    includeClosed: flagBool(args, 'include-closed') || undefined,
    limit: flagInt(args, 'limit'),
    where: whereArgs(args),
  }),
  item: (args) => ({ id: operandAt(args, 0, 'an item id or issue key') }),
  'create-item': (args) => ({ type: operandAt(args, 0, 'a type'), title: operandAt(args, 1, 'a title'), ...itemWriteArgs(args) }),
  'update-item': (args) => {
    const unset = flagList(args, 'unset');
    if (flagBool(args, 'archive') && flagBool(args, 'unarchive')) throw usageError('Pass only one of --archive or --unarchive.');
    const update = defined({
      title: flagStr(args, 'title'),
      primaryType: flagStr(args, 'primary-type'),
      ...itemWriteArgs(args),
      unsetFields: unset.length ? unset : undefined,
      expectedRevision: flagInt(args, 'expected-revision'),
      archived: flagBool(args, 'archive') ? true : flagBool(args, 'unarchive') ? false : undefined,
    });
    if (Object.keys(update).every((key) => key === 'expectedRevision')) {
      throw usageError('Nothing to update. Pass at least one of --title, --status, --field, --unset, --body, --archive.');
    }
    return { id: operandAt(args, 0, 'an item id or issue key'), ...update };
  },
  comments: (args) => {
    const pages = flagList(args, 'page');
    if (pages.length === 0) throw usageError(`'nim wiki comments' requires --page <uri> (repeatable).`);
    return { kinds: ['comment'], pages, query: flagStr(args, 'query'), limit: flagInt(args, 'limit') };
  },
};

export function pagesToolCall(args: ParsedArgs): PagesToolCall {
  // `ls` is `list`, as on the local wiki.
  const verb = args.verb === 'ls' ? 'list' : (args.verb ?? '');
  const build = (BUILDERS as Record<string, (a: ParsedArgs) => Record<string, unknown>>)[verb];
  if (!build) throw usageError(`Unknown 'nim wiki' subcommand '${verb}'. Run 'nim --help' for the list.`);
  return { tool: PAGES_VERBS[verb as ToolVerb], args: defined(build(args)) };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const NODE_COLUMNS: Column[] = [
  { header: 'title', get: (n) => `${'  '.repeat(Math.max(0, Number(n.depth) || 0))}${n.title ?? ''}` },
  { header: 'kind', get: (n) => n.kind },
  { header: 'id', get: (n) => n.issueKey ?? n.id },
  { header: 'link', get: (n) => n.link ?? n.viewLink },
];

const ITEM_COLUMNS: Column[] = [
  { header: 'id', get: (r) => field(r, 'issueKey') ?? r.id },
  { header: 'type', get: (r) => field(r, 'type') ?? r.primaryType },
  { header: 'status', get: (r) => field(r, 'status') },
  { header: 'title', get: (r) => field(r, 'title') },
  { header: 'link', get: (r) => r.link ?? r.url },
];

const TYPE_COLUMNS: Column[] = [
  { header: 'type', get: (t) => t.type ?? t.id },
  { header: 'name', get: (t) => t.displayName },
  { header: 'extends', get: (t) => t.extends },
];

const SEARCH_COLUMNS: Column[] = [
  { header: 'title', get: (r) => r.title },
  { header: 'kind', get: (r) => r.kind },
  { header: 'snippet', get: (r) => r.snippet },
  { header: 'link', get: (r) => r.link ?? r.uri },
];

const MEMBER_COLUMNS: Column[] = [
  { header: 'name', get: (m) => m.displayName },
  { header: 'email', get: (m) => m.email },
  { header: 'member', get: (m) => m.memberId },
];

const INPUT_COLUMNS: Column[] = [
  { header: 'by', get: (i) => i.email ?? i.by },
  { header: 'at', get: (i) => i.at },
  { header: 'quote', get: (i) => i.quote },
  { header: 'key', get: (i) => i.key },
];

function rowsOf(result: any, key: string): any[] | undefined {
  if (Array.isArray(result?.[key])) return result[key];
  return Array.isArray(result) ? result : undefined;
}

function renderResult(ctx: PagesCtx, toolName: string, result: any): string {
  const opts = outputOptions(ctx.args);
  // Page bodies and the tools' one-line answers are text; keep their lines.
  if (typeof result === 'string') return safeBlock(result);
  const table = (rows: any[] | undefined, columns: Column[], id: (row: any) => unknown) => (rows ? renderRows(rows, columns, opts, id) : undefined);
  const rendered =
    toolName === 'listPages' ? table(rowsOf(result, 'nodes'), NODE_COLUMNS, (n) => n.nodeId)
    : toolName === 'tracker_list' ? table(rowsOf(result, 'items'), ITEM_COLUMNS, (r) => field(r, 'issueKey') ?? r.id)
    : toolName === 'tracker_list_types' ? table(rowsOf(result, 'types'), TYPE_COLUMNS, (t) => t.type ?? t.id)
    : toolName === 'searchPages' ? table(rowsOf(result, 'results'), SEARCH_COLUMNS, (r) => r.issueKey ?? r.id)
    : toolName === 'findOrgMembers' ? table(rowsOf(result, 'members'), MEMBER_COLUMNS, (m) => m.email)
    : toolName === 'list_citable_inputs' ? table(rowsOf(result, 'inputs'), INPUT_COLUMNS, (i) => i.key)
    : undefined;
  if (rendered !== undefined) return rendered;
  if (result && typeof result === 'object' && Object.values(result).every((v) => v === null || typeof v !== 'object')) {
    const idKey = ['documentId', 'folderId', 'itemId', 'id'].find((key) => key in result) ?? 'id';
    return renderObject(result, opts, idKey);
  }
  return safeBlock(JSON.stringify(result ?? null, null, 2));
}

export async function runPages(args: ParsedArgs): Promise<number> {
  const startDir = flagStr(args, 'workspace') ?? process.cwd();
  const ctx = teamsCtx(args, resolveServer(), startDir);
  switch (args.verb) {
    case 'status':
      return runStatus(ctx);
    case 'pin':
      return runPin(ctx);
    case 'bind':
      return runBind(ctx);
    case 'create-project':
      return runCreateProject(ctx);
  }
  const call = pagesToolCall(args);
  const result = await tool(ctx, call.tool, call.args);
  return print(ctx, result, () => renderResult(ctx, call.tool, result));
}

