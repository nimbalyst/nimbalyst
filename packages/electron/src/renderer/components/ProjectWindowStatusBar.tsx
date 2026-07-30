import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';

import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import { teamInboxSnapshotAtom } from '../store/atoms/teamInbox';
import {
  formatUnreadCount,
  selectProjectWindowUnreadSummary,
  selectProjectWindowUnreadTarget,
} from '../store/projectWindowUnreadViewModel';
import './ProjectWindowStatusBar.css';

const api = () => (window as { electronAPI?: any }).electronAPI;

export interface ProjectWindowStatusBarProps {
  workspacePath?: string | null;
}

export function ProjectWindowStatusBar({
  workspacePath,
}: ProjectWindowStatusBarProps) {
  const activePathFromAtom = useAtomValue(activeWorkspacePathAtom);
  const activePath = activePathFromAtom ?? workspacePath ?? null;
  const inboxSnapshot = useAtomValue(teamInboxSnapshotAtom);
  const [workspaceOrgTarget, setWorkspaceOrgTarget] = useState<{
    workspacePath: string | null;
    orgId: string | null;
  }>({ workspacePath: null, orgId: null });

  useEffect(() => {
    let cancelled = false;
    if (!activePath) {
      setWorkspaceOrgTarget({ workspacePath: null, orgId: null });
      return () => { cancelled = true; };
    }

    (async () => {
      try {
        const found = await api()?.team?.findForWorkspace?.(activePath);
        if (!cancelled) {
          setWorkspaceOrgTarget({
            workspacePath: activePath,
            orgId: found?.team?.orgId ?? null,
          });
        }
      } catch {
        if (!cancelled) {
          setWorkspaceOrgTarget({ workspacePath: activePath, orgId: null });
        }
      }
    })();

    return () => { cancelled = true; };
  }, [activePath]);

  const unreadSummary = useMemo(
    () => selectProjectWindowUnreadSummary(inboxSnapshot),
    [inboxSnapshot],
  );
  const workspaceOrgResolved = (
    activePath === null || workspaceOrgTarget.workspacePath === activePath
  );
  const targetOrgId = useMemo(
    () => (
      workspaceOrgResolved
        ? selectProjectWindowUnreadTarget(unreadSummary, workspaceOrgTarget.orgId)
        : null
    ),
    [unreadSummary, workspaceOrgResolved, workspaceOrgTarget.orgId],
  );

  if (unreadSummary.totalUnread === 0 || !targetOrgId) return null;

  return (
    <footer
      className="project-window-status-bar"
      data-testid="project-window-status-bar"
      data-component="ProjectWindowStatusBar"
    >
      <button
        type="button"
        className="project-window-status-bar__unread-chip"
        data-testid="project-window-unread-chip"
        aria-label={`Open organization inbox with ${unreadSummary.totalUnread} unread`}
        title="Open organization inbox"
        onClick={() => {
          void api()?.team?.openManagementWindow?.({
            orgId: targetOrgId,
            workspacePath: activePath ?? undefined,
          });
        }}
      >
        <span className="project-window-status-bar__unread-dot" aria-hidden="true" />
        <span>{formatUnreadCount(unreadSummary.totalUnread)} unread</span>
      </button>
    </footer>
  );
}
