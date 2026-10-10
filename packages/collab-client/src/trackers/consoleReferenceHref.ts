/**
 * The console link a new typed-page reference is written with, so the desktop
 * and the web console write the same link for the same item.
 */
import { buildConsoleLink } from '@nimbalyst/collab-protocol';

/** A host's team project as console links address it, or null when it has none. */
export interface ConsoleReferenceTeam {
  orgId: string;
  teamProjectId: string;
}

/**
 * A team link when the host has a team and the item is not personal (an item
 * the host does not know is assumed to be the team's); a local link otherwise.
 */
export function trackerReferenceLinkFor(
  referenceKey: string,
  team: ConsoleReferenceTeam | null,
  record: { syncStatus: 'local' | 'pending' | 'synced' } | null,
): string {
  const scope = team && record?.syncStatus !== 'local' ? { orgId: team.orgId, projectId: team.teamProjectId } : 'local';
  return buildConsoleLink({ kind: 'item', scope, itemRef: referenceKey });
}
