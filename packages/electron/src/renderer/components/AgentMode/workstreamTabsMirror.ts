/**
 * Guard for WorkstreamEditorTabs' persist effect (NIM-1680).
 *
 * On mount, the restore effect seeds TabsContext from openResources via async
 * state updates and the persist effect runs in the same flush while the tabs
 * array is still empty. Mirroring that transient [] into openResources flips
 * workstreamHasOpenResources false, and AgentWorkstreamPanel's auto-collapse
 * effect reverts the layout to 'transcript', unmounting the strip — a
 * just-opened tracker tab flashes and closes (React 19's effect scheduling
 * made the collapse reliably observe the empty intermediate state).
 *
 * While seeded tabs have not yet materialized, an empty tab set must not be
 * mirrored. Once they land (or nothing was seeded), empty mirrors are
 * legitimate last-tab-closed writes.
 */
export function shouldSkipResourceMirror({
  pendingSeedCount,
  tabCount,
}: {
  pendingSeedCount: number;
  tabCount: number;
}): boolean {
  return pendingSeedCount > 0 && tabCount === 0;
}
