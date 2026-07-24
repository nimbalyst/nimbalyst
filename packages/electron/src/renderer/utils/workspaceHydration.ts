/**
 * Shared guard for effects that mirror asynchronously hydrated workspace state.
 * A value may be persisted only after the currently visible workspace supplied
 * the baseline, unless the user explicitly changed it while loading.
 */
export function canPersistWorkspaceHydratedState(
  workspacePath: string | null | undefined,
  loadedWorkspacePath: string | null,
  changedBeforeLoad = false,
): boolean {
  if (!workspacePath) return false;
  return loadedWorkspacePath === workspacePath || changedBeforeLoad;
}
