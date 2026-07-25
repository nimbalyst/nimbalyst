/**
 * Project sync selection for the Mobile App panel.
 *
 * Two independent-looking axes with one dependency between them:
 * - `enabledProjects` — the project is reachable from the mobile app at all.
 * - `docSyncEnabledProjects` — its `.md` files sync too. A doc-synced project
 *   must also be mobile-enabled, so turning docs on pulls the project in and
 *   turning mobile sync off drops docs with it.
 *
 * Every change (one checkbox or Select all) goes through here so bulk edits are
 * a single config write plus exactly the membership toggles that actually
 * changed. Pure — tested in `__tests__/projectSyncSelection.test.ts`.
 */

export interface ProjectSyncSelection {
  enabledProjects: string[];
  docSyncEnabledProjects: string[];
}

export interface ProjectSyncChange {
  axis: 'mobile' | 'docs';
  /** Projects the change applies to — one for a checkbox, all of them for Select all. */
  projectPaths: string[];
  enabled: boolean;
}

export interface ProjectSyncChangeResult {
  next: ProjectSyncSelection & { enabled: boolean };
  /** `sync:toggle-project` calls needed for the membership changes, in list order. */
  syncToggles: Array<{ projectPath: string; enabled: boolean }>;
  /** Projects whose doc sync switched on, so the caller can poll their status. */
  docSyncTurnedOn: string[];
}

/** Keep the caller's ordering stable so the config diff stays readable. */
function withPaths(current: string[], paths: string[], enabled: boolean): string[] {
  if (!enabled) {
    const removing = new Set(paths);
    return current.filter((path) => !removing.has(path));
  }
  const existing = new Set(current);
  return [...current, ...paths.filter((path) => !existing.has(path))];
}

export function applyProjectSyncChange(
  current: ProjectSyncSelection,
  change: ProjectSyncChange,
): ProjectSyncChangeResult {
  const before = new Set(current.enabledProjects);
  const beforeDocs = new Set(current.docSyncEnabledProjects);

  let enabledProjects = current.enabledProjects;
  let docSyncEnabledProjects = current.docSyncEnabledProjects;

  if (change.axis === 'mobile') {
    enabledProjects = withPaths(enabledProjects, change.projectPaths, change.enabled);
    // Docs cannot outlive mobile access for a project.
    if (!change.enabled) {
      docSyncEnabledProjects = withPaths(docSyncEnabledProjects, change.projectPaths, false);
    }
  } else {
    docSyncEnabledProjects = withPaths(docSyncEnabledProjects, change.projectPaths, change.enabled);
    if (change.enabled) {
      enabledProjects = withPaths(enabledProjects, change.projectPaths, true);
    }
  }

  const after = new Set(enabledProjects);
  const syncToggles: Array<{ projectPath: string; enabled: boolean }> = [];
  for (const projectPath of new Set([...current.enabledProjects, ...enabledProjects])) {
    if (before.has(projectPath) !== after.has(projectPath)) {
      syncToggles.push({ projectPath, enabled: after.has(projectPath) });
    }
  }

  return {
    next: {
      enabledProjects,
      docSyncEnabledProjects,
      // Sync as a whole is on exactly while at least one project is selected.
      enabled: enabledProjects.length > 0,
    },
    syncToggles,
    docSyncTurnedOn: docSyncEnabledProjects.filter((path) => !beforeDocs.has(path)),
  };
}

/**
 * Push a computed selection to main as ONE call. Selecting 20 projects must not
 * become 20 read-modify-writes plus 20 sync triggers — the handler takes the
 * full membership sets and applies them in a single write + single trigger.
 */
export async function persistProjectSyncSelection(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  next: ProjectSyncSelection,
): Promise<void> {
  await invoke('sync:set-project-selection', {
    enabledProjects: next.enabledProjects,
    docSyncEnabledProjects: next.docSyncEnabledProjects,
  });
}

export type SelectionState = 'none' | 'some' | 'all';

/** Tri-state for the Select all / Deselect all header control. */
export function selectionState(selected: string[], allPaths: string[]): SelectionState {
  if (allPaths.length === 0) return 'none';
  const chosen = new Set(selected);
  const count = allPaths.filter((path) => chosen.has(path)).length;
  if (count === 0) return 'none';
  return count === allPaths.length ? 'all' : 'some';
}
