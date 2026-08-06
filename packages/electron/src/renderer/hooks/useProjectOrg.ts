import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';

import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { projectOrgRevisionAtom } from '../store/atoms/orgScope';

export interface ProjectOrg {
  orgId: string;
  name: string;
}

export interface ProjectOrgState {
  org: ProjectOrg | null;
  /** True until the lookup for the current workspace has answered. */
  loading: boolean;
}

/**
 * The organization the active project belongs to, or `null` when it has none.
 *
 * Several surfaces need this at once — the top bar's inbox control, the account
 * popover's Messages and Organization rows — and each used to run its own
 * `findForWorkspace` round trip with its own cancel bookkeeping. The active
 * workspace atom wins over the caller's path: a window's `workspacePath` prop is
 * the root project, while the atom follows the project the user is actually
 * looking at.
 *
 * Callers must distinguish `loading` from a resolved `null`: rendering "No
 * organization" over an unfinished lookup reads as a definitive answer, and
 * during org creation it was a wrong one.
 */
export function useProjectOrg(workspacePath?: string | null): ProjectOrgState {
  const activePathFromAtom = useAtomValue(activeWorkspacePathAtom);
  const activePath = activePathFromAtom ?? workspacePath ?? null;
  // Creating an organization binds it to this workspace in the main process;
  // nothing about the workspace path changes, so the revision is what tells the
  // lookup to run again.
  const revision = useAtomValue(projectOrgRevisionAtom);
  const [resolved, setResolved] = useState<{
    workspacePath: string | null;
    org: ProjectOrg | null;
  } | null>(null);

  useEffect(() => {
    if (!activePath) {
      setResolved({ workspacePath: null, org: null });
      return;
    }

    const pending = (window as { electronAPI?: any })
      .electronAPI?.team?.findForWorkspace?.(activePath);
    if (!pending) {
      setResolved({ workspacePath: activePath, org: null });
      return;
    }

    let cancelled = false;
    void pending
      .then((result: any) => {
        if (cancelled) return;
        const found = result?.team ?? result;
        setResolved({
          workspacePath: activePath,
          org: found?.orgId ? { orgId: found.orgId, name: found.name } : null,
        });
      })
      .catch(() => {
        if (!cancelled) setResolved({ workspacePath: activePath, org: null });
      });

    return () => { cancelled = true; };
  }, [activePath, revision]);

  // Report the switch as still in flight rather than the previous project's org,
  // so a badge never briefly claims the wrong organization.
  if (!resolved || resolved.workspacePath !== activePath) {
    return { org: null, loading: activePath !== null };
  }
  return { org: resolved.org, loading: false };
}
