/**
 * Which Pages-sidebar sections are collapsed, persisted per workspace in
 * `workspaceState.pagesSidebarCollapsed`. A section the user never toggled
 * has no stored value and follows the default: Team open and Personal closed
 * when there is a team, Personal open when there is not.
 */

import { useCallback, useEffect, useState } from 'react';

export type PagesSidebarSection = 'team' | 'personal';
export type PagesSidebarCollapsed = { team?: boolean; personal?: boolean };

export function resolvePagesSidebarCollapsed(
  stored: PagesSidebarCollapsed | undefined,
  hasTeam: boolean,
): { team: boolean; personal: boolean } {
  return {
    team: stored?.team ?? false,
    personal: stored?.personal ?? hasTeam,
  };
}

export function usePagesSidebarCollapse(workspacePath: string, hasTeam: boolean) {
  const [stored, setStored] = useState<PagesSidebarCollapsed | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setStored(undefined);
    void window.electronAPI.invoke('workspace:get-state', workspacePath)
      .then((state: { pagesSidebarCollapsed?: PagesSidebarCollapsed } | null) => {
        // A toggle made before the load landed wins for its own section only.
        if (live) setStored((prev) => ({ ...state?.pagesSidebarCollapsed, ...prev }));
      })
      .catch((error: unknown) => {
        console.error('[PagesSidebar] Failed to load collapsed sections:', error);
      });
    return () => { live = false; };
  }, [workspacePath]);

  const collapsed = resolvePagesSidebarCollapsed(stored, hasTeam);

  const toggle = useCallback((section: PagesSidebarSection) => {
    const value = !collapsed[section];
    setStored((prev) => ({ ...prev, [section]: value }));
    void window.electronAPI.invoke('workspace:update-state', workspacePath, {
      pagesSidebarCollapsed: { [section]: value },
    }).catch((error: unknown) => {
      console.error('[PagesSidebar] Failed to persist collapsed sections:', error);
    });
  }, [collapsed, workspacePath]);

  return { collapsed, toggle };
}
