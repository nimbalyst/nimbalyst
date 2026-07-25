/**
 * VENDORED SUBSET of `packages/runtime/src/plugins/TrackerPlugin/models/trackerReleases.ts`.
 *
 * Same rationale as `trackerRecord.ts`: the runtime package ships Vite bundle
 * chunks, not standalone Node-ESM modules, so the CLI cannot import it at
 * runtime. These functions are pure.
 *
 * KEEP IN SYNC with the runtime module. The one deliberate divergence: member
 * ids are read straight off the built-in release type's `items` field rather
 * than resolved through the schema registry, because the CLI does not load
 * tracker schemas. A custom type with a differently-named members field is out
 * of scope for `nim release`.
 */

import type { TrackerRecord } from './trackerRecord.js';

export const RELEASE_TYPE = 'release';
export const RELEASE_MEMBERS_FIELD = 'items';

const CLOSED_RELEASE_STATUSES = new Set(['released', 'cancelled']);

export interface ReleaseFinalizeInput {
  version: string;
  gitTag?: string;
  channel?: string;
  releasedAt?: string;
}

export function releaseFinalizeFields(
  input: ReleaseFinalizeInput,
  nowIso: string,
): Record<string, unknown> {
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

function statusOf(record: TrackerRecord): string {
  return String(record.fields?.status ?? '');
}

export function findPendingReleases(items: TrackerRecord[]): TrackerRecord[] {
  return items
    .filter((item) => item.primaryType === RELEASE_TYPE
      && !item.archived
      && !CLOSED_RELEASE_STATUSES.has(statusOf(item)))
    .sort((a, b) => {
      const rank = (record: TrackerRecord) => (statusOf(record) === 'in-progress' ? 0 : 1);
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return String(b.system?.createdAt ?? '').localeCompare(String(a.system?.createdAt ?? ''));
    });
}

/** Member ids on a release, deduped and in stored order. */
export function releaseMemberIds(release: TrackerRecord): string[] {
  const raw = release.fields?.[RELEASE_MEMBERS_FIELD];
  const list = Array.isArray(raw) ? raw : [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const id = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' ? String((entry as { itemId?: unknown }).itemId ?? '') : '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export interface ReleaseNoteLine {
  type: string;
  title: string;
  issueKey?: string;
}

export function releaseNoteLines(
  release: TrackerRecord,
  itemsById: ReadonlyMap<string, TrackerRecord>,
): ReleaseNoteLine[] {
  const lines: ReleaseNoteLine[] = [];
  for (const id of releaseMemberIds(release)) {
    const member = itemsById.get(id);
    if (!member || member.archived) continue;
    lines.push({
      type: member.primaryType,
      title: String(member.fields?.title ?? ''),
      ...(member.issueKey ? { issueKey: member.issueKey } : {}),
    });
  }
  return lines;
}

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
