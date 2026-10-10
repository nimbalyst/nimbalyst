/**
 * The desktop's cross-page marks list: what main reads from local bodies
 * (typed pages, Personal pages, Personal type pages) plus plain team pages and
 * team type pages from the server's marks index. Typed pages always come from
 * the local copy; the server does not index their bodies.
 *
 * Open lists load again when a team says its marks changed or its connection
 * comes up, and keep retrying while the index's answer is missing or partial.
 * They also load again, once per burst, after a local page body, typed page
 * or the team's page list changes.
 */

import type { PageMarkEntry, PageMarkEntryKind } from '@nimbalyst/collab-protocol';
import {
  filterPageMarks,
  mergePageMarks,
  PageMarksChangeFeed,
  pageMarkRecordsFromTeamIndex,
  type PageMarkRecord,
  type PageMarksQuery,
  type PageMarksSource,
} from '@nimbalyst/collab-client/pages';
import { onTeamPageMarksChanged } from '@nimbalyst/runtime/sync/teamPageMarks';
import { watchLocalPageMarks } from './desktopPageMarksWatch';

/** A save, an import or a sync batch changes many items at once; reload once after it. */
const LOCAL_CHANGE_SETTLE_MS = 300;

export interface DesktopTeamMarksIndex {
  orgId: string;
  /** Null when offline or the server did not answer. */
  query(filters: { kind?: PageMarkEntryKind; email?: string }): Promise<{ marks: PageMarkEntry[]; status: 'ready' | 'partial' } | null>;
}

export interface DesktopPageMarksDeps {
  listLocal(query: PageMarksQuery): Promise<PageMarkRecord[]>;
  /** The active team's index, or null when the project has no team. */
  teamIndex(): DesktopTeamMarksIndex | null;
  /** Defaults to every team connection's change notice. */
  watchTeam?(listener: () => void): () => void;
  /** Defaults to this window's Personal pages, tracker items and team page list. */
  watchLocal?(listener: () => void): () => void;
}

async function teamMarks(index: DesktopTeamMarksIndex | null, query: PageMarksQuery): Promise<{ records: PageMarkRecord[]; complete: boolean }> {
  if (!index) return { records: [], complete: true };
  try {
    const result = await index.query({
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.email ? { email: query.email } : {}),
    });
    if (!result) return { records: [], complete: false };
    return { records: pageMarkRecordsFromTeamIndex(result.marks, { orgId: index.orgId }), complete: result.status === 'ready' };
  } catch (error) {
    // The local marks still answer; a server hiccup only narrows the list.
    console.warn('[pageMarks] team marks index unavailable:', error);
    return { records: [], complete: false };
  }
}

export function createDesktopPageMarksSource(deps: DesktopPageMarksDeps): PageMarksSource {
  const feed = new PageMarksChangeFeed();
  const watchTeam = deps.watchTeam ?? onTeamPageMarksChanged;
  const watchLocal = deps.watchLocal ?? watchLocalPageMarks;
  const read: NonNullable<PageMarksSource['listMarksResult']> = async (query) => {
    const [local, team] = await Promise.all([deps.listLocal(query), teamMarks(deps.teamIndex(), query)]);
    feed.settled(team.complete);
    return { marks: filterPageMarks(mergePageMarks(local, team.records), query), status: team.complete ? 'ready' : 'partial' };
  };
  return {
    listMarks: async query => (await read(query)).marks,
    listMarksResult: read,
    subscribe(listener) {
      const stopRetries = feed.subscribe(listener);
      const stopTeam = watchTeam(listener);
      let settle: ReturnType<typeof setTimeout> | null = null;
      const stopLocal = watchLocal(() => {
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => {
          settle = null;
          listener();
        }, LOCAL_CHANGE_SETTLE_MS);
      });
      return () => {
        stopRetries();
        stopTeam();
        stopLocal();
        if (settle) clearTimeout(settle);
      };
    },
  };
}
