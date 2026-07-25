/**
 * `nim release <verb>` — the release item as the release scripts see it.
 *
 * A release exists in the tracker before it is built. `finalize` is what the
 * release script calls once the version and tag are real: it fills them in on
 * the *existing* item and flips the status, rather than creating a record after
 * the fact. `notes` reads that item's members so the changelog and the tracker
 * tell one story.
 */
import type { ParsedArgs } from '../cli/parse.js';
import { flagStr, flagBool } from '../cli/parse.js';
import { usageError, notFoundError } from '../cli/exitCodes.js';
import { makeGateway } from './common.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import { green, dim } from '../cli/colors.js';
import type { TrackerRecord } from '../vendor/trackerRecord.js';
import {
  RELEASE_TYPE,
  findPendingReleases,
  releaseFinalizeFields,
  releaseNoteLines,
  renderReleaseNotes,
} from '../vendor/trackerReleases.js';
import type { TrackerGateway } from '../gateway/types.js';

export async function runRelease(args: ParsedArgs): Promise<number> {
  switch (args.verb) {
    case 'list':
      return releaseList(args);
    case 'finalize':
      return releaseFinalize(args);
    case 'notes':
      return releaseNotes(args);
    default:
      throw usageError(
        `Unknown release command '${args.verb ?? ''}'. Try: list, finalize, notes.`,
      );
  }
}

/** All release items, or (with --pending) only those still open. */
async function releaseList(args: ParsedArgs): Promise<number> {
  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    const releases = await listReleases(gateway, workspace);
    const shown = flagBool(args, 'pending') ? findPendingReleases(releases) : releases;

    if (flagBool(args, 'json')) {
      process.stdout.write(JSON.stringify(shown, null, 2) + '\n');
      return 0;
    }
    if (shown.length === 0) {
      process.stdout.write(dim('No release items.') + '\n');
      return 0;
    }
    for (const release of shown) {
      const version = String(release.fields?.version ?? '');
      process.stdout.write(
        `${release.issueKey ?? release.id}  ${String(release.fields?.status ?? '')}  `
        + `${version || dim('(unversioned)')}  ${String(release.fields?.title ?? '')}\n`,
      );
    }
    return 0;
  } finally {
    gateway.close();
  }
}

/**
 * Fill version / tag / date on the release item and mark it released. Targets
 * the single pending release unless one is named -- guessing between several
 * would silently ship the wrong bucket.
 */
async function releaseFinalize(args: ParsedArgs): Promise<number> {
  const version = flagStr(args, 'version');
  if (!version) throw usageError(`'nim release finalize' requires --version <x.y.z>.`);

  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    const target = await resolveRelease(gateway, workspace, args.positionals[0]);

    const fields = releaseFinalizeFields(
      {
        version,
        gitTag: flagStr(args, 'tag'),
        channel: flagStr(args, 'channel'),
        releasedAt: flagStr(args, 'date'),
      },
      new Date().toISOString(),
    );
    const { status, ...rest } = fields as { status: string } & Record<string, unknown>;
    const record = await gateway.updateTracker(workspace, target.issueKey ?? target.id, {
      status,
      fields: rest,
    });

    if (flagBool(args, 'quiet')) {
      process.stdout.write((record.issueKey ?? record.id) + '\n');
    } else {
      process.stdout.write(
        green(`Released ${record.issueKey ?? record.id}`) + dim(` (${version})`) + '\n',
      );
    }
    return 0;
  } finally {
    gateway.close();
  }
}

/** Markdown notes built from the release's members, for the CHANGELOG. */
async function releaseNotes(args: ParsedArgs): Promise<number> {
  const gateway = makeGateway(args);
  try {
    const workspace = await resolveWorkspace(gateway, flagStr(args, 'workspace'));
    const target = await resolveRelease(gateway, workspace, args.positionals[0]);
    const all = await gateway.listTrackers({ workspace, limit: -1 });
    const itemsById = new Map(all.map((item) => [item.id, item]));

    const lines = releaseNoteLines(target, itemsById);
    if (flagBool(args, 'json')) {
      process.stdout.write(JSON.stringify(lines, null, 2) + '\n');
      return 0;
    }
    const rendered = renderReleaseNotes(lines);
    process.stdout.write((rendered || dim('No members on this release yet.')) + '\n');
    return 0;
  } finally {
    gateway.close();
  }
}

async function listReleases(gateway: TrackerGateway, workspace: string): Promise<TrackerRecord[]> {
  return gateway.listTrackers({ workspace, type: RELEASE_TYPE, limit: -1 });
}

/**
 * The release a verb acts on: the named one, or the single pending one.
 * Ambiguity is an error, never a guess.
 */
async function resolveRelease(
  gateway: TrackerGateway,
  workspace: string,
  reference: string | undefined,
): Promise<TrackerRecord> {
  if (reference) {
    const record = await gateway.getTracker(workspace, reference);
    if (!record) throw notFoundError(`No tracker item found for '${reference}'.`);
    if (record.primaryType !== RELEASE_TYPE) {
      throw usageError(`'${reference}' is a ${record.primaryType}, not a release.`);
    }
    return record;
  }

  const pending = findPendingReleases(await listReleases(gateway, workspace));
  if (pending.length === 0) {
    throw notFoundError(
      'No pending release item. Create one (type `release`) before finalizing, or name one explicitly.',
    );
  }
  if (pending.length > 1) {
    const keys = pending.map((r) => r.issueKey ?? r.id).join(', ');
    throw usageError(`Several releases are still open (${keys}). Name the one you mean.`);
  }
  return pending[0];
}
