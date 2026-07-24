/**
 * `nim tracker <verb>` — the v1 noun, fully wired for reads.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { flagStr, flagBool, flagInt } from '../cli/parse.js';
import { usageError, notFoundError, writeNotPermittedError } from '../cli/exitCodes.js';
import {
  makeGateway,
  outputOptions,
  buildFilters,
  buildCreateInput,
  buildUpdateInput,
} from './common.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import {
  renderList,
  renderRecord,
  renderTypes,
  renderImporters,
  renderImporterSearch,
  renderImportResult,
  renderResnapshot,
} from '../cli/output.js';
import { loadTypeSchema } from './typeSchema.js';
import { dim, green } from '../cli/colors.js';
import * as fs from 'fs';

export async function runTracker(args: ParsedArgs): Promise<number> {
  const verb = args.verb;
  switch (verb) {
    case 'list':
      return trackerList(args);
    case 'get':
    case 'show':
      return trackerGet(args, verb === 'show');
    case 'types':
      return trackerTypes(args);
    case 'create':
      return trackerCreate(args);
    case 'update':
      return trackerUpdate(args);
    case 'comment':
      return trackerComment(args);
    case 'archive':
      return trackerArchive(args, true);
    case 'unarchive':
      return trackerArchive(args, false);
    case 'link-session':
      return trackerLinkSession(args);
    case 'importers':
      return trackerImporters(args);
    case 'import':
      return trackerImport(args);
    default:
      throw usageError(
        `Unknown tracker command '${verb ?? ''}'. Try: list, get, show, types, create, update, ` +
          `comment, archive, link-session, importers, import.`,
      );
  }
}

async function trackerList(args: ParsedArgs): Promise<number> {
  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    const filters = buildFilters(args, workspace);
    const records = await gateway.listTrackers(filters);
    process.stdout.write(renderList(records, outputOptions(args)) + '\n');
    return 0;
  } finally {
    gateway.close();
  }
}

async function trackerGet(args: ParsedArgs, withBody: boolean): Promise<number> {
  const reference = args.positionals[0];
  if (!reference) throw usageError(`'nim tracker ${args.verb}' requires an id, issue key, or urn.`);

  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    const isUrn = reference.includes('://');
    const record = isUrn
      ? await gateway.getTrackerByUrn(workspace, reference)
      : await gateway.getTracker(workspace, reference);

    if (!record) {
      throw notFoundError(`No tracker item found for '${reference}'.`);
    }

    const wantBody = withBody || flagBool(args, 'body') || flagBool(args, 'json');
    const body = wantBody ? await gateway.getTrackerBody(workspace, record) : undefined;
    process.stdout.write(renderRecord(record, body, outputOptions(args)) + '\n');
    return 0;
  } finally {
    gateway.close();
  }
}

async function trackerTypes(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0]; // e.g. `show <type>`
  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    const types = await gateway.listTypes(workspace);

    if (sub === 'show') {
      const wanted = args.positionals[1];
      if (!wanted) throw usageError(`'nim tracker types show' requires a type name.`);
      const match = types.find((t) => t.type === wanted);
      if (!match) throw notFoundError(`Tracker type '${wanted}' not found in this workspace.`);
      const opts = outputOptions(args);
      process.stdout.write((opts.json ? JSON.stringify(match, null, 2) : renderTypes([match], opts)) + '\n');
      return 0;
    }

    if (sub === 'define') {
      const file = flagStr(args, 'file');
      if (!file) throw usageError(`'nim tracker types define' requires -f/--file <schema.yaml|.json>.`);
      const { schema, fileName } = loadTypeSchema(file);
      await gateway.defineType(workspace, schema, fileName);
      process.stdout.write(green(`Defined tracker type '${schema.type ?? '(unknown)'}'.`) + '\n');
      return 0;
    }

    if (sub === 'rm' || sub === 'delete') {
      const wanted = args.positionals[1];
      if (!wanted) throw usageError(`'nim tracker types rm' requires a type name.`);
      await gateway.deleteType(workspace, wanted);
      process.stdout.write(green(`Deleted tracker type '${wanted}'.`) + '\n');
      return 0;
    }

    process.stdout.write(renderTypes(types, outputOptions(args)) + '\n');
    return 0;
  } finally {
    gateway.close();
  }
}

async function trackerCreate(args: ParsedArgs): Promise<number> {
  const input = buildCreateInput(args);
  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    const record = await gateway.createTracker(workspace, input);
    if (flagBool(args, 'json')) {
      process.stdout.write(renderRecord(record, undefined, outputOptions(args)) + '\n');
    } else if (flagBool(args, 'quiet')) {
      process.stdout.write((record.issueKey ?? record.id) + '\n');
    } else {
      process.stdout.write(green(`Created ${record.issueKey ?? record.id}`) + dim(` (${record.primaryType})`) + '\n');
    }
    return 0;
  } finally {
    gateway.close();
  }
}

async function trackerUpdate(args: ParsedArgs): Promise<number> {
  const reference = args.positionals[0];
  if (!reference) throw usageError(`'nim tracker update' requires an id or issue key.`);
  const input = buildUpdateInput(args);
  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    const record = await gateway.updateTracker(workspace, reference, input);
    if (flagBool(args, 'json')) {
      process.stdout.write(renderRecord(record, undefined, outputOptions(args)) + '\n');
    } else if (flagBool(args, 'quiet')) {
      process.stdout.write((record.issueKey ?? record.id) + '\n');
    } else {
      process.stdout.write(green(`Updated ${record.issueKey ?? record.id}`) + '\n');
    }
    return 0;
  } finally {
    gateway.close();
  }
}

async function trackerComment(args: ParsedArgs): Promise<number> {
  const reference = args.positionals[0];
  if (!reference) throw usageError(`'nim tracker comment' requires an id or issue key.`);
  // Body can be the second positional or --body / --body-file.
  const body = args.positionals[1] ?? flagStr(args, 'body') ?? readBodyFile(args);
  if (!body) throw usageError(`'nim tracker comment' requires a comment body (positional, --body, or --body-file).`);
  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    await gateway.commentTracker(workspace, reference, body);
    if (!flagBool(args, 'quiet')) process.stdout.write(green(`Commented on ${reference}.`) + '\n');
    return 0;
  } finally {
    gateway.close();
  }
}

async function trackerArchive(args: ParsedArgs, archived: boolean): Promise<number> {
  const reference = args.positionals[0];
  if (!reference) throw usageError(`'nim tracker ${archived ? 'archive' : 'unarchive'}' requires an id or issue key.`);
  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    const record = await gateway.setArchived(workspace, reference, archived);
    if (!flagBool(args, 'quiet')) {
      process.stdout.write(green(`${archived ? 'Archived' : 'Unarchived'} ${record.issueKey ?? record.id}.`) + '\n');
    }
    return 0;
  } finally {
    gateway.close();
  }
}

async function trackerLinkSession(args: ParsedArgs): Promise<number> {
  const reference = args.positionals[0];
  if (!reference) throw usageError(`'nim tracker link-session' requires an id or issue key.`);
  const gateway = makeGateway(args);
  if (gateway.mode !== 'live') {
    gateway.close();
    throw writeNotPermittedError('link-session requires live mode (a running Nimbalyst). It links an in-app AI session.');
  }
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    await gateway.linkSession(workspace, reference, flagStr(args, 'session'));
    if (!flagBool(args, 'quiet')) process.stdout.write(green(`Linked session to ${reference}.`) + '\n');
    return 0;
  } finally {
    gateway.close();
  }
}

async function trackerImporters(args: ParsedArgs): Promise<number> {
  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    const importers = await gateway.importerList(workspace);
    process.stdout.write(renderImporters(importers, outputOptions(args)) + '\n');
    return 0;
  } finally {
    gateway.close();
  }
}

async function trackerImport(args: ParsedArgs): Promise<number> {
  const sub = args.positionals[0];

  // `nim tracker import search <providerId> [--repo owner/repo] ...`
  if (sub === 'search') {
    const providerId = args.positionals[1];
    if (!providerId) {
      throw usageError(`'nim tracker import search' requires a provider id, e.g. 'github-issues'.`);
    }
    const gateway = makeGateway(args);
    try {
      const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
      const result = await gateway.importerSearch(workspace, {
        providerId,
        bindingId: flagStr(args, 'repo') ?? flagStr(args, 'binding'),
        search: flagStr(args, 'search'),
        state: flagStr(args, 'state'),
        limit: flagInt(args, 'limit'),
      });
      process.stdout.write(renderImporterSearch(result, outputOptions(args)) + '\n');
      return 0;
    } finally {
      gateway.close();
    }
  }

  // `nim tracker import resnapshot <urn>`
  if (sub === 'resnapshot') {
    const urn = args.positionals[1];
    if (!urn) throw usageError(`'nim tracker import resnapshot' requires a URN, e.g. github://owner/repo#42.`);
    const gateway = makeGateway(args);
    try {
      const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
      const result = await gateway.resnapshot(workspace, urn);
      process.stdout.write(renderResnapshot(result, outputOptions(args)) + '\n');
      return 0;
    } finally {
      gateway.close();
    }
  }

  // `nim tracker import <providerId> <externalId> [--type T]`
  const providerId = args.positionals[0];
  const externalId = args.positionals[1];
  if (!providerId || !externalId) {
    throw usageError(
      `'nim tracker import' requires a provider id and external id, e.g. ` +
        `'nim tracker import github-issues 42'. (Or use 'import search' / 'import resnapshot'.)`,
    );
  }
  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    const result = await gateway.importItem(workspace, {
      providerId,
      externalId,
      primaryType: flagStr(args, 'primary-type') ?? flagStr(args, 'type'),
    });
    process.stdout.write(renderImportResult(result, outputOptions(args)) + '\n');
    return 0;
  } finally {
    gateway.close();
  }
}

function readBodyFile(args: ParsedArgs): string | undefined {
  const file = flagStr(args, 'body-file');
  if (!file) return undefined;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    throw usageError(`Could not read --body-file "${file}": ${err?.message ?? err}`);
  }
}
