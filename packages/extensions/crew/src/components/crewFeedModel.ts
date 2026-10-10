/**
 * Ordering and filtering for the crew feed. Pure so the rules a reader cannot
 * see on screen (what is pinned, which segment owns what, how pages merge) are
 * testable without rendering.
 */
import type { CrewFeedEntry, CrewMemberSnapshot } from '../shared/types';

export type CrewFeedFilter = 'all' | 'flags' | 'summaries' | 'activity';

export const CREW_FEED_FILTERS: ReadonlyArray<{ id: CrewFeedFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'flags', label: 'Flags' },
  { id: 'summaries', label: 'Summaries' },
  { id: 'activity', label: 'Activity' },
];

/**
 * Which segment an entry belongs to; every entry lands in exactly one.
 * Flag- and page-level flags need attention. A note-level flag (a standup)
 * reads with shift summaries and handoffs as the day's reporting. Journal
 * lines, schedule changes and budget/system notices are background activity.
 */
export function crewFeedSegment(entry: CrewFeedEntry): Exclude<CrewFeedFilter, 'all'> {
  switch (entry.kind) {
    case 'flag':
      return entry.level === 'note' ? 'summaries' : 'flags';
    case 'shift':
    case 'handoff':
      return 'summaries';
    default:
      return 'activity';
  }
}

export interface CrewFeedView {
  /**
   * Members with a question open in one of their sessions, pinned above
   * everything regardless of age. Asks live in the sessions as interactive
   * prompts, not in the journal, so they come from roster state.
   */
  waiting: CrewMemberSnapshot[];
  /** Journal entries under the filter, newest first. */
  stream: CrewFeedEntry[];
}

export function buildCrewFeed(
  entries: readonly CrewFeedEntry[],
  members: readonly CrewMemberSnapshot[],
  filter: CrewFeedFilter,
): CrewFeedView {
  // Asks are questions; the Flags and Summaries filters are about the journal.
  const waiting = filter === 'all' || filter === 'flags'
    ? members
      .filter((m) => m.runtime.status === 'waiting-on-user')
      .sort((a, b) => a.definition.name.localeCompare(b.definition.name))
    : [];
  const stream = entries.filter((entry) => filter === 'all' || crewFeedSegment(entry) === filter);
  return { waiting, stream: [...stream].sort(newestFirst) };
}

function newestFirst(a: CrewFeedEntry, b: CrewFeedEntry): number {
  const delta = Date.parse(b.at) - Date.parse(a.at);
  // Stable for identical timestamps so cards never swap on a refetch.
  return delta !== 0 && Number.isFinite(delta) ? delta : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merge a fetched page into what the feed already holds. Keyed by id, the
 * incoming copy wins (a journal line can be corrected in place). A refresh
 * returns only the newest page, so entries loaded through "Show older" must
 * survive it rather than being replaced by the shorter list.
 */
export function mergeFeedEntries(current: readonly CrewFeedEntry[], incoming: readonly CrewFeedEntry[]): CrewFeedEntry[] {
  if (incoming.length === 0) return current as CrewFeedEntry[];
  const byId = new Map(current.map((entry) => [entry.id, entry] as const));
  for (const entry of incoming) byId.set(entry.id, entry);
  return [...byId.values()].sort(newestFirst);
}

/** The `before` cursor for the next older page: the oldest timestamp held. */
export function oldestFeedTimestamp(entries: readonly CrewFeedEntry[]): string | undefined {
  let oldest: CrewFeedEntry | undefined;
  for (const entry of entries) {
    if (!oldest || Date.parse(entry.at) < Date.parse(oldest.at)) oldest = entry;
  }
  return oldest?.at;
}
