/** A host's team project as console links address it, or null when it has none. */
export interface ConsoleReferenceTeam {
    orgId: string;
    teamProjectId: string;
}
/**
 * A team link when the host has a team and the item is not personal (an item
 * the host does not know is assumed to be the team's); a local link otherwise.
 */
export declare function trackerReferenceLinkFor(referenceKey: string, team: ConsoleReferenceTeam | null, record: {
    syncStatus: 'local' | 'pending' | 'synced';
} | null): string;
