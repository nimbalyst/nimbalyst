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
export function resolveMyMemberIds(
  members: ReadonlyMap<string, { email?: string }>,
  currentUserId: string | null | undefined,
  currentEmail: string | null | undefined,
): Set<string> {
  const set = new Set<string>();
  if (currentUserId) set.add(currentUserId);
  if (currentEmail) {
    const email = currentEmail.toLowerCase();
    for (const [id, info] of members) {
      if (info.email && info.email.toLowerCase() === email) set.add(id);
    }
  }
  return set;
}

export const SHARED_HOME_TAB_URI = 'virtual://shared-home';
export const SHARED_HOME_TAB_TITLE = 'Shared Home';

/** True when a tab filePath is the Shared Docs Home surface. */
export function isSharedHomeTab(filePath: string): boolean {
  return filePath === SHARED_HOME_TAB_URI;
}

/**
 * Per-type accent color for the list-view Type chip. Only the type icon + the
 * chip are colored (matching the mockup); everything else stays monochrome.
 *
 * Resolved primarily off the human `typeLabel` (which mirrors the mockup's
 * labels: Document, Diagram, Mockup, Tracker, Spreadsheet, Mindmap, Data model,
 * Upload), with `documentType` as a secondary hint and a stable hashed color as
 * the last resort so an unknown extension type still reads as its own color.
 */
export function sharedDocTypeColor(
  typeLabel: string | undefined,
  documentType?: string | undefined,
): string {
  const haystack = `${typeLabel ?? ''} ${documentType ?? ''}`.toLowerCase();

  const rules: Array<[RegExp, string]> = [
    [/diagram|excalidraw|drawing/, '#2dd4bf'], // teal
    [/mockup|wireframe/, '#f5a623'], // amber
    [/tracker|issue|bug|task/, '#a855f7'], // purple
    [/spreadsheet|sheet|revogrid|csv/, '#22c55e'], // green
    [/mind ?map/, '#ec4899'], // pink
    [/data ?model|prisma|schema|erd/, '#06b6d4'], // cyan
    [/upload|attachment|file/, '#8a94a6'], // gray
    [/text|code/, '#8a94a6'], // gray
    [/document|markdown|doc\b|note/, '#4a9eff'], // blue
  ];
  for (const [re, color] of rules) {
    if (re.test(haystack)) return color;
  }

  // Stable hashed hue for unknown extension types.
  let hash = 0;
  for (let i = 0; i < haystack.length; i++) {
    hash = (hash << 5) - hash + haystack.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 60% 60%)`;
}
