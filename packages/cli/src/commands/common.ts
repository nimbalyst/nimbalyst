/**
 * Shared command plumbing: build a gateway, derive output options, and translate
 * cross-cutting flags into ListFilters.
 */
import {
  parseArgs,
  flagStr,
  flagBool,
  flagList,
  flagInt,
  type ParsedArgs,
} from '../cli/parse.js';
import { selectGateway } from '../gateway/select.js';
import type { TrackerGateway } from '../gateway/types.js';
import type { ListFilters, WhereClause } from '../gateway/types.js';
import type { OutputOptions } from '../cli/output.js';
import { parseTimeBound } from '../cli/time.js';
import { usageError } from '../cli/exitCodes.js';
import type { CreateInput, UpdateInput } from '../gateway/types.js';
import * as fs from 'fs';

export function makeGateway(args: ParsedArgs): TrackerGateway {
  return selectGateway({
    live: flagBool(args, 'live'),
    offline: flagBool(args, 'offline'),
    db: flagStr(args, 'db'),
  });
}

export function outputOptions(args: ParsedArgs): OutputOptions {
  return {
    json: flagBool(args, 'json'),
    csv: flagBool(args, 'csv'),
    quiet: flagBool(args, 'quiet'),
    columns: flagStr(args, 'column') ? undefined : parseColumns(args),
  };
}

function parseColumns(args: ParsedArgs): string[] | undefined {
  const cols = flagStr(args, 'columns');
  if (!cols) return undefined;
  return cols.split(',').map((c) => c.trim()).filter(Boolean);
}

export function buildFilters(args: ParsedArgs, workspace: string): ListFilters {
  const since = flagStr(args, 'since');
  const until = flagStr(args, 'until');
  const dateField = flagStr(args, 'date-field');
  if (dateField && dateField !== 'updated' && dateField !== 'created') {
    throw usageError(`--date-field must be 'updated' or 'created'`);
  }

  const all = flagBool(args, 'all');
  const limit = all ? -1 : flagInt(args, 'limit');

  return {
    workspace,
    type: flagStr(args, 'type'),
    typeTag: flagStr(args, 'type-tag'),
    status: flagStr(args, 'status'),
    priority: flagStr(args, 'priority'),
    owner: resolveOwner(flagStr(args, 'owner')),
    search: flagStr(args, 'search'),
    since: since ? parseTimeBound(since) : undefined,
    until: until ? parseTimeBound(until) : undefined,
    dateField: (dateField as 'updated' | 'created' | undefined) ?? 'updated',
    where: parseWhere(flagList(args, 'where')),
    includeArchived: flagBool(args, 'archived') || flagBool(args, 'all'),
    limit,
  };
}

function resolveOwner(owner: string | undefined): string | undefined {
  if (owner === 'me') {
    return process.env.NIM_OWNER || process.env.USER || process.env.USERNAME || 'me';
  }
  return owner;
}

/** Parse `field<op>value` clauses. Ops: =, !=, ~ (contains), in: (csv). */
export function parseWhere(raw: string[]): WhereClause[] {
  return raw.map((clause) => {
    // Order matters: check two-char / prefixed ops before '='.
    let m: RegExpMatchArray | null;
    if ((m = clause.match(/^([^=!~]+)!=(.*)$/))) {
      return { field: m[1].trim(), op: '!=', value: m[2] };
    }
    if ((m = clause.match(/^([^=!~]+)~(.*)$/))) {
      return { field: m[1].trim(), op: '~', value: m[2] };
    }
    if ((m = clause.match(/^([^=!~]+)\s+in:(.*)$/)) || (m = clause.match(/^([^=!~]+)=in:(.*)$/))) {
      return { field: m[1].trim(), op: 'in', value: m[2] };
    }
    if ((m = clause.match(/^([^=!~]+)=(.*)$/))) {
      return { field: m[1].trim(), op: '=', value: m[2] };
    }
    throw usageError(
      `Could not parse --where "${clause}". Use field=value, field!=value, field~value, or field=in:a,b,c`,
    );
  });
}

// ---- write input builders --------------------------------------------------

/** Parse repeatable `--field key=value` flags into a field bag. JSON-ish values
 *  (numbers, true/false, null) are coerced; everything else stays a string. */
export function parseFields(raw: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of raw) {
    const eq = entry.indexOf('=');
    if (eq < 0) throw usageError(`--field expects key=value, got "${entry}"`);
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1);
    out[key] = coerceScalar(value);
  }
  return out;
}

function coerceScalar(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return Number.parseFloat(v);
  return v;
}

/** Resolve description body from --body <text> or --body-file <path>. */
export function readBody(args: ParsedArgs): string | undefined {
  const inline = flagStr(args, 'body');
  const file = flagStr(args, 'body-file');
  if (inline !== undefined && file !== undefined) {
    throw usageError('Pass only one of --body or --body-file.');
  }
  if (inline !== undefined) return inline;
  if (file !== undefined) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err: any) {
      throw usageError(`Could not read --body-file "${file}": ${err?.message ?? err}`);
    }
  }
  return undefined;
}

export function buildCreateInput(args: ParsedArgs): CreateInput {
  const type = args.positionals[0];
  const title = args.positionals[1];
  if (!type) throw usageError(`'nim tracker create' requires a type, e.g. 'nim tracker create bug "Title"'.`);
  if (!title) throw usageError(`'nim tracker create' requires a title.`);

  const fields = parseFields(flagList(args, 'field'));
  const tags = flagList(args, 'tag');
  const labels = flagList(args, 'label');
  const typeTags = flagList(args, 'type-tag');

  return {
    type,
    title,
    description: readBody(args),
    status: flagStr(args, 'status'),
    priority: flagStr(args, 'priority'),
    owner: resolveOwner(flagStr(args, 'owner')),
    dueDate: flagStr(args, 'due'),
    progress: flagInt(args, 'progress'),
    tags: tags.length ? tags : undefined,
    labels: labels.length ? labels : undefined,
    typeTags: typeTags.length ? typeTags : undefined,
    linkedCommitSha: flagStr(args, 'link-commit'),
    fields: Object.keys(fields).length ? fields : undefined,
    linkSession: flagBool(args, 'link-session'),
  };
}

export function buildUpdateInput(args: ParsedArgs): UpdateInput {
  const fields = parseFields(flagList(args, 'field'));
  const tags = flagList(args, 'tag');
  const labels = flagList(args, 'label');
  const typeTags = flagList(args, 'type-tag');
  const unset = flagList(args, 'unset');

  const input: UpdateInput = {
    title: flagStr(args, 'title'),
    status: flagStr(args, 'status'),
    priority: flagStr(args, 'priority'),
    description: readBody(args),
    owner: resolveOwner(flagStr(args, 'owner')),
    dueDate: flagStr(args, 'due'),
    progress: flagInt(args, 'progress'),
    tags: tags.length ? tags : undefined,
    labels: labels.length ? labels : undefined,
    typeTags: typeTags.length ? typeTags : undefined,
    primaryType: flagStr(args, 'primary-type'),
    linkedCommitSha: flagStr(args, 'link-commit'),
    fields: Object.keys(fields).length ? fields : undefined,
    unsetFields: unset.length ? unset : undefined,
  };

  // Require at least one mutation so a typo'd update doesn't silently no-op.
  const hasChange = Object.values(input).some((v) => v !== undefined);
  if (!hasChange) {
    throw usageError('Nothing to update. Pass at least one of --status, --priority, --field, --unset, etc.');
  }
  return input;
}

export { parseArgs };
