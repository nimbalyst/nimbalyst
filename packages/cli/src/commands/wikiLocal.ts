/**
 * `nim wiki ...` over the project's local wiki folder (see localWiki/).
 *
 * `nim wiki` is one noun for both wikis. A verb only the team wiki has
 * (status, edit, create, items, ...) goes to the team wiki (commands/pages.ts).
 * `init` and `write` are local only. `list`/`ls`, `read`, `move` and `search`
 * exist on both: they use the local wiki when the project has one and the call
 * names no team target (a collab:// uri, a console link, or
 * --repo/--org/--project), else the team wiki. `--team` and `--local` force it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ParsedArgs } from '../cli/parse.js';
import { flagBool, flagInt, flagStr } from '../cli/parse.js';
import { CliError, ExitCode, notFoundError, usageError } from '../cli/exitCodes.js';
import { bold, dim } from '../cli/colors.js';
import { resolveServer } from '../cloud/config.js';
import { loadCredentials } from '../cloud/credentials.js';
import { resolveWikiLocation } from '../localWiki/locate.js';
import { hasLocalWiki, initLocalWiki, openLocalWiki } from '../localWiki/open.js';
import { buildTree, findPage, isTeamReference, positionBeside } from '../localWiki/tree.js';

/** Verbs the local wiki has; `ls` is `list`. */
const LOCAL_VERBS = new Set(['init', 'list', 'ls', 'read', 'write', 'move', 'search']);
/** Local verbs with no team counterpart. */
const LOCAL_ONLY = new Set(['init', 'write']);

const startDir = (args: ParsedArgs) => flagStr(args, 'workspace') ?? process.cwd();

export function isLocalWikiCall(args: ParsedArgs): boolean {
  const verb = args.verb;
  if (!verb) return false;
  const team = flagBool(args, 'team');
  const local = flagBool(args, 'local');
  if (team && local) throw usageError('Pass --team or --local, not both.');
  if (team) {
    if (LOCAL_ONLY.has(verb)) {
      throw usageError(`'nim wiki ${verb}' is for the local wiki.${verb === 'write' ? " On the team wiki, use 'nim wiki edit'." : ''}`);
    }
    return false;
  }
  if (local) {
    if (!LOCAL_VERBS.has(verb)) throw usageError(`'nim wiki ${verb}' is for the team wiki; the local wiki has ${[...LOCAL_VERBS].join(', ')}.`);
    return true;
  }
  if (!LOCAL_VERBS.has(verb)) return false;
  if (LOCAL_ONLY.has(verb)) return true;
  if (flagStr(args, 'repo') || flagStr(args, 'org') || flagStr(args, 'project')) return false;
  if (args.positionals[0] && isTeamReference(args.positionals[0])) return false;
  if (hasLocalWiki(startDir(args), flagStr(args, 'location'))) return true;
  // Neither wiki is reachable: say how to get each, not just "log in".
  if (!loadCredentials(resolveServer())) {
    const { dir } = resolveWikiLocation(startDir(args), flagStr(args, 'location'));
    throw new CliError(
      ExitCode.NOT_FOUND,
      `No local wiki at ${dir}, and not signed in to a team wiki. Run 'nim wiki init' for a local wiki, or 'nim login' for the team wiki.`,
    );
  }
  return false;
}

const json = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

function requireRef(args: ParsedArgs, verb: string): string {
  const ref = args.positionals[0];
  if (!ref) throw usageError(`nim wiki ${verb} needs a page: an id, a path in the wiki, or a title`);
  return ref;
}

function readInput(args: ParsedArgs): string {
  const file = flagStr(args, 'file');
  if (file !== undefined) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw usageError(`Could not read --file "${file}": ${(err as Error).message}`);
    }
  }
  if (process.stdin.isTTY) throw usageError('nim wiki write reads the page body from stdin or --file <path>');
  return fs.readFileSync(0, 'utf8');
}

export async function runLocalWiki(args: ParsedArgs): Promise<number> {
  const location = flagStr(args, 'location');
  if (args.verb === 'init') {
    const result = await initLocalWiki(startDir(args), location);
    result.wiki.close();
    if (flagBool(args, 'json')) {
      json({ dir: result.dir, created: result.created, homeId: result.homeId, gitignoreUpdated: result.gitignoreUpdated });
      return ExitCode.OK;
    }
    const lines = [`${result.created ? 'Created' : 'Already a local wiki:'} ${result.dir}`];
    lines.push(`Location saved in ${path.join('.nimbalyst', 'local-wiki.json')}`);
    if (result.homeId) lines.push(`Home page: ${result.homeId}`);
    if (result.gitignoreUpdated) lines.push('Added nimbalyst-local/ to .gitignore');
    process.stdout.write(lines.join('\n') + '\n');
    return ExitCode.OK;
  }

  const { wiki } = await openLocalWiki(startDir(args), location);
  try {
    switch (args.verb) {
      case 'list':
      case 'ls':
        return await runLs(args, wiki);
      case 'read':
        return await runRead(args, wiki);
      case 'write':
        return await runWrite(args, wiki);
      case 'move':
        return await runMove(args, wiki);
      case 'search':
        return await runSearch(args, wiki);
      default:
        throw usageError(`nim wiki: unknown local verb '${args.verb}'`);
    }
  } finally {
    wiki.close();
  }
}

type Wiki = Awaited<ReturnType<typeof openLocalWiki>>['wiki'];

async function runLs(args: ParsedArgs, wiki: Wiki): Promise<number> {
  const tree = buildTree(await wiki.snapshot());
  if (flagBool(args, 'json')) {
    json(tree);
    return ExitCode.OK;
  }
  for (const node of tree) {
    const indent = '  '.repeat(node.depth);
    const kind = node.type ?? node.documentType;
    const detail = node.kind === 'type' ? `table, ${node.rowCount ?? 0} rows` : kind ? `${kind}  ${node.id}` : node.id;
    process.stdout.write(`${indent}${node.title}  ${dim(detail)}\n`);
  }
  return ExitCode.OK;
}

async function runRead(args: ParsedArgs, wiki: Wiki): Promise<number> {
  const page = findPage(await wiki.snapshot(), requireRef(args, 'read'));
  const body = await wiki.readBody(page.id);
  if (flagBool(args, 'json')) {
    // An editor page's body (a drawing, mind map...) is its whole file text.
    json({ id: page.id, title: page.title, type: page.type, documentType: page.documentType, path: page.path, fields: page.fields, version: body.version, markdown: body.markdown });
  } else {
    process.stdout.write(body.markdown);
  }
  return ExitCode.OK;
}

async function runWrite(args: ParsedArgs, wiki: Wiki): Promise<number> {
  const ref = requireRef(args, 'write');
  const markdown = readInput(args);
  const snapshot = await wiki.snapshot();
  let pageId: string | null = null;
  try {
    pageId = findPage(snapshot, ref).id;
  } catch (err) {
    if (!(err instanceof CliError && err.code === ExitCode.NOT_FOUND && flagBool(args, 'create'))) throw err;
  }
  if (pageId === null) {
    const parentRef = flagStr(args, 'parent');
    const parentFolderId = parentRef ? findPage(snapshot, parentRef).id : null;
    const created = await wiki.command({ type: 'register-document', title: ref, parentFolderId, body: markdown });
    const page = findPage(await wiki.snapshot(), created.id!);
    report(args, { id: page.id, path: page.path, version: page.version, created: true });
    return ExitCode.OK;
  }
  const result = await wiki.writeBody(pageId, markdown, flagStr(args, 'expected-version') ?? null);
  if (!result.ok) {
    throw new CliError(
      ExitCode.CONFLICT,
      `the page changed since version ${flagStr(args, 'expected-version')} (now ${result.currentVersion}); nothing was written. ` +
        `Read it again with \`nim wiki read ${ref} --json\` and reapply your change.`,
    );
  }
  report(args, { id: pageId, version: result.version, created: false });
  return ExitCode.OK;
}

function report(args: ParsedArgs, value: { id: string; version: string; created: boolean; path?: string | null }) {
  if (flagBool(args, 'json')) json(value);
  else process.stdout.write(`${value.created ? 'Created' : 'Wrote'} ${value.id}  ${dim(`version ${value.version}`)}\n`);
}

async function runMove(args: ParsedArgs, wiki: Wiki): Promise<number> {
  let snapshot = await wiki.snapshot();
  const page = findPage(snapshot, requireRef(args, 'move'));
  const before = flagStr(args, 'before');
  const after = flagStr(args, 'after');
  const parentRef = flagStr(args, 'parent');
  const toRoot = flagBool(args, 'root');
  const title = flagStr(args, 'title');
  if ([before, after, parentRef, toRoot || undefined].filter(Boolean).length > 1) {
    throw usageError('Pass one of --parent, --root, --before or --after');
  }
  if (!before && !after && !parentRef && !toRoot && !title) {
    throw usageError('nim wiki move needs --parent <page>, --root, --before <page>, --after <page> or --title <title>');
  }
  if (before || after) {
    const at = positionBeside(snapshot, (before ?? after)!, before ? 'before' : 'after', page.id);
    await wiki.command({ type: 'move-document', documentId: page.id, parentFolderId: at.parentId, sortOrder: at.sortOrder });
  } else if (parentRef || toRoot) {
    const parentFolderId = parentRef ? findPage(snapshot, parentRef).id : null;
    await wiki.command({ type: 'move-document', documentId: page.id, parentFolderId });
  }
  if (title) await wiki.command({ type: 'update-document-title', documentId: page.id, title });
  snapshot = await wiki.snapshot();
  const moved = snapshot.pages.find((p) => p.id === page.id);
  if (!moved) throw notFoundError(`${page.id} is gone after the move`);
  if (flagBool(args, 'json')) json({ id: moved.id, title: moved.title, path: moved.path, parentId: moved.parentId });
  else process.stdout.write(`Moved ${moved.id}  ${dim(moved.path ?? moved.dir)}\n`);
  return ExitCode.OK;
}

async function runSearch(args: ParsedArgs, wiki: Wiki): Promise<number> {
  const query = args.positionals.join(' ').trim();
  if (!query) throw usageError('nim wiki search needs words to find');
  const hits = await wiki.search(query, { limit: flagInt(args, 'limit') ?? 20 });
  if (flagBool(args, 'json')) {
    json(hits);
    return ExitCode.OK;
  }
  if (hits.length === 0) process.stdout.write(dim('No matches.') + '\n');
  for (const hit of hits) {
    process.stdout.write(`${bold(hit.title)}  ${dim(`${hit.id}  ${hit.path ?? ''}`)}\n  ${hit.snippet}\n`);
  }
  return ExitCode.OK;
}
