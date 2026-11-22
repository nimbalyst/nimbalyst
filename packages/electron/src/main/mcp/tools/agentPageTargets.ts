/**
 * Pages an agent reads and edits through `readCollabDoc` / `applyCollabDocEdit`:
 * shared pages (`collab://`), typed-page bodies (`collab://tracker-content/<id>`)
 * and Personal pages (`personal://`, Decision 20).
 *
 * The success text names the page, `Updated "<title>" (<uri>)`, which is what
 * the transcript's "Updated <page>" line shows.
 */

import { globalRegistry } from '@nimbalyst/tracker-schema';
import { getDatabase } from '../../database/initialize';
import { getEffectiveTrackerSharingPolicy, shouldSyncTrackerItem } from '../../services/TrackerPolicyService';
import { parseTrackerBodyUri } from '@nimbalyst/collab-protocol';
import { isPersonalPageUri, parsePersonalPageUri } from '../../../shared/personalPageUri';
import { resolveTrackerRowByReference } from './trackerToolItemAccess';
import { rowToTrackerItem } from './trackerToolHandlers';

const TEAM_TYPED_PAGE_PREFIX = 'collab://tracker-content/';

export function isAgentPageUri(uri: string | undefined): uri is string {
  return !!uri && (uri.startsWith('collab://') || isPersonalPageUri(uri));
}

/** The tracker item behind a typed-page body URI, team or Personal. */
export function typedPageItemId(uri: string): string | null {
  const team = parseTrackerBodyUri(uri);
  if (team) return team.itemId;
  const personal = parsePersonalPageUri(uri);
  return personal?.kind === 'typed-page' ? personal.itemId : null;
}

export interface TypedPageFacts {
  title: string;
  /** True when the item's body is the team's collaborative document. */
  shared: boolean;
}

export async function describeTypedPage(itemId: string, workspacePath: string | undefined): Promise<TypedPageFacts | null> {
  const db = getDatabase();
  if (!db) return null;
  const row = await resolveTrackerRowByReference(db as any, itemId, workspacePath);
  if (!row) return null;
  const item = rowToTrackerItem(row);
  const workspace = row.workspace || workspacePath;
  const shared = workspace
    ? shouldSyncTrackerItem(getEffectiveTrackerSharingPolicy(workspace, row.type, globalRegistry.get(row.type)), item)
    : false;
  return { title: String(item.title || itemId), shared };
}

/**
 * The page an agent's read or edit of `uri` reaches. A Personal typed-page URI
 * for an item whose body is the team's goes to the team body room: a write to
 * the local copy would be replaced by the room's, and a read of it can be
 * stale (#1879).
 */
export async function resolveAgentPageTarget(
  uri: string,
  workspacePath: string | undefined,
): Promise<{ uri: string } | { error: string }> {
  const personal = isPersonalPageUri(uri) ? parsePersonalPageUri(uri) : null;
  if (!personal) return isPersonalPageUri(uri) ? { error: `Error: Not a Personal page URI: ${uri}` } : { uri };
  if (personal.kind !== 'typed-page') return { uri };
  const facts = await describeTypedPage(personal.itemId, workspacePath);
  if (!facts) return { error: `Error: Unknown typed page '${personal.itemId}'.` };
  return { uri: facts.shared ? `${TEAM_TYPED_PAGE_PREFIX}${personal.itemId}` : uri };
}

export function pageUpdatedText(uri: string, title: string | undefined): string {
  return title ? `Updated "${title}" (${uri})` : `Updated ${uri}`;
}
