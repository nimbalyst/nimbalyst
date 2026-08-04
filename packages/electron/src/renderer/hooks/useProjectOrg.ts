import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';

import { activeWorkspacePathAtom } from '../store/atoms/openProjects';

export interface ProjectOrg {
  orgId: string;
  name: string;
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
 */
export function useProjectOrg(workspacePath?: string | null): ProjectOrg | null {
  const activePathFromAtom = useAtomValue(activeWorkspacePathAtom);
  const activePath = activePathFromAtom ?? workspacePath ?? null;
  const [resolved, setResolved] = useState<{
    workspacePath: string | null;
    org: ProjectOrg | null;
  }>({ workspacePath: null, org: null });

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
  }, [activePath]);

  // Report null while a switch is in flight rather than the previous project's
  // org, so a badge never briefly claims the wrong organization.
  return resolved.workspacePath === activePath ? resolved.org : null;
}
