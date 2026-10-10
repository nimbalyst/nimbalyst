/**
 * The journal is the crew's only history store: shift summaries, flags,
 * schedule changes, handoffs, and the member's own entries all land in
 * `nimbalyst-local/crew/<slug>/journal.md`, and the panel's feed is parsed back
 * out of it. There is no database table behind the feed.
 *
 * Each entry is a readable markdown section with one HTML comment carrying the
 * structured fields, so the file stays pleasant to read and edit while the
 * feed can still tell a page from a shift summary:
 *
 *   ## Mon, Sep 28, 2026, 18:30 EDT - Shift summary
 *   <!-- crew {"at":"2026-09-28T22:30:00.000Z","kind":"shift","title":"Shift summary"} -->
 *
 *   Reviewed the sync refactor...
 *
 * Sections without the marker (hand-written notes, entries from before this
 * format) stay in the file and in the member's recent-journal context; they
 * just do not appear in the feed.
 */

import type {
  CrewEvidenceRef,
  CrewFeedEntry,
  CrewFeedKind,
  CrewLevel,
  CrewShiftTrigger,
} from '../shared/types';
import { appendJournalEntry } from './crewFiles';
import { formatLocalStamp } from './crewPolicy';

export interface JournalEntryInput {
  kind: CrewFeedKind;
  title: string;
  body: string;
  atMs: number;
  level?: Exclude<CrewLevel, 'ask'>;
  trigger?: CrewShiftTrigger;
  chapterIndex?: number;
  sessionId?: string;
  evidence?: CrewEvidenceRef[];
}

const MARKER_RE = /^<!-- crew (\{.*\}) -->$/;

interface Marker {
  at: string;
  kind: CrewFeedKind;
  title: string;
  level?: Exclude<CrewLevel, 'ask'>;
  trigger?: CrewShiftTrigger;
  chapter?: number;
  session?: string;
  evidence?: CrewEvidenceRef[];
}

/** JSON inside an HTML comment may not contain `--`; `-` is the same string to JSON.parse. */
function encodeMarker(marker: Marker): string {
  return `<!-- crew ${JSON.stringify(marker).replace(/--/g, '-\\u002d')} -->`;
}

export function formatJournalEntry(entry: JournalEntryInput, timeZone: string): { heading: string; body: string } {
  const title = entry.title.replace(/\s+/g, ' ').trim() || 'Entry';
  const marker: Marker = {
    at: new Date(entry.atMs).toISOString(),
    kind: entry.kind,
    title,
    ...(entry.level ? { level: entry.level } : {}),
    ...(entry.trigger ? { trigger: entry.trigger } : {}),
    ...(entry.chapterIndex !== undefined ? { chapter: entry.chapterIndex } : {}),
    ...(entry.sessionId ? { session: entry.sessionId } : {}),
    ...(entry.evidence && entry.evidence.length > 0 ? { evidence: entry.evidence } : {}),
  };
  return {
    heading: `${formatLocalStamp(entry.atMs, timeZone)} - ${title}`,
    body: `${encodeMarker(marker)}\n\n${entry.body.trim() || '(no details)'}`,
  };
}

export async function appendCrewJournal(
  workspacePath: string,
  slug: string,
  entry: JournalEntryInput,
  timeZone: string,
): Promise<void> {
  await appendJournalEntry(workspacePath, slug, formatJournalEntry(entry, timeZone));
}

/** Feed entries in a journal, oldest first as written. */
export function parseJournalFeed(slug: string, journal: string): CrewFeedEntry[] {
  const entries: CrewFeedEntry[] = [];
  const sections = journal.split(/\r?\n(?=## )/).filter((part) => part.startsWith('## '));
  sections.forEach((section, ordinal) => {
    const lines = section.split(/\r?\n/);
    const markerIndex = lines.findIndex((line, index) => index > 0 && line.trim() !== '');
    if (markerIndex < 0) return;
    const match = MARKER_RE.exec(lines[markerIndex].trim());
    if (!match) return;
    let marker: Marker;
    try {
      marker = JSON.parse(match[1]) as Marker;
    } catch {
      return;
    }
    if (typeof marker.at !== 'string' || !Number.isFinite(Date.parse(marker.at))) return;
    entries.push({
      id: `${slug}:${marker.at}:${ordinal}`,
      memberSlug: slug,
      at: marker.at,
      kind: marker.kind,
      title: marker.title,
      body: lines.slice(markerIndex + 1).join('\n').trim(),
      ...(marker.level ? { level: marker.level } : {}),
      ...(marker.trigger ? { trigger: marker.trigger } : {}),
      ...(marker.chapter !== undefined ? { chapterIndex: marker.chapter } : {}),
      ...(marker.session ? { sessionId: marker.session } : {}),
      ...(marker.evidence ? { evidence: marker.evidence } : {}),
    });
  });
  return entries;
}

/** Newest first across members, filtered and paged. */
export function mergeFeeds(
  feeds: readonly CrewFeedEntry[][],
  options: { limit?: number; before?: string; kinds?: readonly CrewFeedKind[] },
): CrewFeedEntry[] {
  const beforeMs = options.before ? Date.parse(options.before) : Number.POSITIVE_INFINITY;
  const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
  return feeds
    .flat()
    .filter((entry) => Date.parse(entry.at) < beforeMs && (!kinds || kinds.has(entry.kind)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id))
    .slice(0, Math.max(1, Math.min(options.limit ?? 100, 500)));
}
