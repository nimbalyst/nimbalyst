/**
 * Releases as tracker items.
 *
 * A release is a collection (see `trackerCollections.ts`) that exists *before*
 * it is built: created early as the "next release" bucket, items associated
 * with it as they land, and only at build time do the version, git tag, and
 * date get filled in and the status flipped. The tag is a field populated late,
 * never the identity of the item -- which is what lets the tracker and the
 * release scripts describe the same release.
 *
 * Pure and I/O-free so the `nim` CLI (which the release script calls), the MCP
 * tools, and the app all agree on which release is pending and what its notes
 * say.
 */

import type { TrackerRecord } from '../../../core/TrackerRecord';
import { getMemberIds } from './trackerCollections';

/** Built-in release type. */
export const RELEASE_TYPE = 'release';

/** Statuses a release can no longer be finalized from. */
const CLOSED_RELEASE_STATUSES = new Set(['released', 'cancelled']);

export interface ReleaseFinalizeInput {
  version: string;
  /** Git tag; defaults to `v<version>`. */
  gitTag?: string;
  channel?: string;
  /** ISO timestamp; defaults to the caller-supplied clock. */
  releasedAt?: string;
}

/**
 * The field writes that finalize a release. Returned rather than applied so the
 * caller owns the single tracker write (and its sync semantics).
 */
export function releaseFinalizeFields(input: ReleaseFinalizeInput, nowIso: string): Record<string, unknown> {
  const version = input.version.trim();
  if (!version) throw new Error('A release version is required');
  return {
    version,
    gitTag: (input.gitTag ?? `v${version}`).trim(),
    releasedAt: input.releasedAt ?? nowIso,
    status: 'released',
    ...(input.channel ? { channel: input.channel } : {}),
  };
}

/**
 * Releases still open for finalizing, newest bucket first. A workspace normally
 * has exactly one; zero means nobody created the next-release item, and more
 * than one means the caller must disambiguate rather than guess.
 */
export function findPendingReleases(
  items: TrackerRecord[],
  getStatus: (record: TrackerRecord) => string,
): TrackerRecord[] {
  return items
    .filter((item) => item.primaryType === RELEASE_TYPE
      && !item.archived
      && !CLOSED_RELEASE_STATUSES.has(getStatus(item)))
    .sort((a, b) => {
      // An explicitly started release outranks one still merely planned.
      const rank = (record: TrackerRecord) => (getStatus(record) === 'in-progress' ? 0 : 1);
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return String(b.system.createdAt ?? '').localeCompare(String(a.system.createdAt ?? ''));
    });
}

export interface ReleaseNoteLine {
  /** Member's tracker type, for grouping. */
  type: string;
  title: string;
  issueKey?: string;
}

/**
 * The release's members as note lines, grouped by type in member order.
 * Unresolved ids (members we don't have loaded) and archived members are
 * skipped -- release notes should never invent an entry for something we can't
 * read.
 */
export function releaseNoteLines(
  release: TrackerRecord,
  itemsById: ReadonlyMap<string, TrackerRecord>,
  getTitle: (record: TrackerRecord) => string,
): ReleaseNoteLine[] {
  const lines: ReleaseNoteLine[] = [];
  for (const id of getMemberIds(release)) {
    const member = itemsById.get(id);
    if (!member || member.archived) continue;
    lines.push({
      type: member.primaryType,
      title: getTitle(member),
      ...(member.issueKey ? { issueKey: member.issueKey } : {}),
    });
  }
  return lines;
}

/** CHANGELOG-shaped markdown for a release's members, grouped by type. */
export function renderReleaseNotes(lines: ReleaseNoteLine[]): string {
  if (lines.length === 0) return '';
  const byType = new Map<string, ReleaseNoteLine[]>();
  for (const line of lines) {
    const bucket = byType.get(line.type);
    if (bucket) bucket.push(line);
    else byType.set(line.type, [line]);
  }
  return [...byType.entries()]
    .map(([type, group]) => {
      const heading = `### ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
      const body = group
        .map((line) => `- ${line.title}${line.issueKey ? ` (${line.issueKey})` : ''}`)
        .join('\n');
      return `${heading}\n\n${body}`;
    })
    .join('\n\n');
}
