// Indirection for the "open or focus a workspace" chokepoint.
//
// The chokepoint itself lives in `window/WorkspaceManagerWindow.ts`, which is
// a hub: it pulls in analytics, tracker sync/schema, and the tutorial service,
// and transitively the autoUpdater singleton. Modules that only need to *ask*
// for a workspace to be opened should not evaluate that whole graph at module
// load -- doing so breaks unrelated suites in vitest's node environment, the
// same failure mode `mcpConfigServiceRef.ts` documents.
//
// `index.ts` registers the real opener at startup; callers use `openWorkspace`.
//
// Longer term the chokepoint belongs in its own light module so this ref is
// unnecessary; that refactor touches ~10 importers and is deliberately out of
// scope here.

// Type-only: erased at compile time, so this creates no runtime edge into
// the heavy module it is declared in.
import type { ProjectOpenOutcome, ProjectOpenOutcomeAsync } from './WorkspaceManagerWindow';

type Opener = (workspacePath: string) => ProjectOpenOutcome;
type AsyncOpener = (workspacePath: string) => Promise<ProjectOpenOutcomeAsync>;

let opener: Opener | null = null;
let asyncOpener: AsyncOpener | null = null;

export function setWorkspaceOpener(fn: Opener): void {
  opener = fn;
}

export function setWorkspaceOpenerAwaitingRailSeed(fn: AsyncOpener): void {
  asyncOpener = fn;
}

/**
 * Open or focus `workspacePath`, waiting for the rail seed to be confirmed
 * when the project joins an existing window's rail.
 *
 * Resolves to null only if called before startup registered the opener.
 * Callers must treat that like a seed that did not land -- i.e. do not
 * deliver a payload against a window that may not host the project.
 */
export async function openWorkspaceAwaitingRailSeed(
  workspacePath: string,
): Promise<ProjectOpenOutcomeAsync | null> {
  return asyncOpener ? asyncOpener(workspacePath) : null;
}

/**
 * Open or focus `workspacePath`. Returns null only if called before startup
 * registered the opener, which callers must treat as "could not open".
 */
export function openWorkspace(workspacePath: string): ProjectOpenOutcome | null {
  return opener ? opener(workspacePath) : null;
}
