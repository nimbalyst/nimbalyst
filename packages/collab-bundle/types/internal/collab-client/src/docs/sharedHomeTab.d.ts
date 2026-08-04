/**
 * Shared Docs Home — the singleton list-view tab (NIM-1790).
 *
 * The redesigned Shared Docs Home opens as ONE virtual tab in CollabMode's
 * TabsContext, addressed by this fixed URI. Because tabs dedupe by `filePath`,
 * a fixed URI makes the tab a singleton for free: re-opening focuses the
 * existing tab instead of creating a second one.
 */
/**
 * Resolve the set of team member ids that represent the current user.
 *
 * The config-reported user id is the user's *personal* member id, which does
 * NOT match the *team-org* member id stamped on a doc's `createdBy` (Stytch
 * gives a different member id per org). So "me" is matched by joining the
 * current user's email against the team member directory, unioned with the
 * config user id as a fallback. Used for the "You" label and the
 * Shared-by-me / Shared-with-me segments.
 */
export declare function resolveMyMemberIds(members: ReadonlyMap<string, {
    email?: string;
}>, currentUserId: string | null | undefined, currentEmail: string | null | undefined): Set<string>;
export declare const SHARED_HOME_TAB_URI = "virtual://shared-home";
export declare const SHARED_HOME_TAB_TITLE = "Shared Home";
/** True when a tab filePath is the Shared Docs Home surface. */
export declare function isSharedHomeTab(filePath: string): boolean;
/**
 * Per-type accent color for the list-view Type chip. Only the type icon + the
 * chip are colored (matching the mockup); everything else stays monochrome.
 *
 * Resolved primarily off the human `typeLabel` (which mirrors the mockup's
 * labels: Document, Diagram, Mockup, Tracker, Spreadsheet, Mindmap, Data model,
 * Upload), with `documentType` as a secondary hint and a stable hashed color as
 * the last resort so an unknown extension type still reads as its own color.
 */
export declare function sharedDocTypeColor(typeLabel: string | undefined, documentType?: string | undefined): string;
