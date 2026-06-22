/**
 * ProjectRail
 *
 * Discord-style vertical rail of warm projects. Click an icon to switch
 * the visible project; the inactive projects' state is kept warm via
 * per-workspace atom families and main-process service refcounting.
 *
 * Hidden when multi-project mode is off (the legacy single-window flow
 * stays as a fallback).
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  useFloating,
  FloatingPortal,
  useDismiss,
  useHover,
  useInteractions,
  useRole,
  offset,
  flip,
  shift,
  type VirtualElement,
} from '@floating-ui/react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { OrgSwitcher } from './OrgSwitcher';
import {
  multiProjectModeAtom,
  openProjectsAtom,
  activeWorkspacePathAtom,
  isOpenProjectsAtCapAtom,
  addOpenProjectAtom,
  closeOpenProjectAtom,
  type OpenProject,
} from '../store/atoms/openProjects';
import {
  globalSessionActivityAtom,
  projectActivitySummaryAtom,
} from '../store/atoms/sessionActivity';
import { generateWorkspaceAccentColor } from './WorkspaceSummaryHeader';
import './ProjectRail.css';

const REVEAL_LABEL = (() => {
  const platform = typeof navigator !== 'undefined' ? navigator.platform : '';
  if (platform.startsWith('Mac')) return 'Reveal in Finder';
  if (platform.startsWith('Win')) return 'Show in Explorer';
  return 'Show in Folder';
})();

function projectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '??';
  const words = trimmed.split(/[-_\s]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

interface ProjectRailIconProps {
  project: OpenProject;
  isActive: boolean;
  processingCount: number;
  unreadCount: number;
  onActivate: (path: string) => void;
  onClose: (project: OpenProject) => void;
  onContextMenu: (project: OpenProject, x: number, y: number) => void;
}

function ProjectRailIcon({
  project,
  isActive,
  processingCount,
  unreadCount,
  onActivate,
  onClose,
  onContextMenu,
}: ProjectRailIconProps) {
  // Hover tooltip via floating-ui. Renders through FloatingPortal so the
  // tooltip escapes the rail container's `overflow: hidden` clip — the
  // earlier CSS-only `:hover > .project-rail-tooltip` approach was clipped
  // and never visible. Matches CLAUDE.md's floating-ui rule.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const { refs: tooltipRefs, floatingStyles: tooltipFloatingStyles, context: tooltipContext } = useFloating({
    open: tooltipOpen,
    onOpenChange: setTooltipOpen,
    placement: 'right',
    middleware: [offset(12), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const tooltipHover = useHover(tooltipContext, { delay: { open: 200, close: 0 }, move: false });
  const { getReferenceProps: getTooltipRefProps, getFloatingProps: getTooltipFloatingProps } =
    useInteractions([tooltipHover]);

  const handleClick = useCallback(() => {
    onActivate(project.path);
  }, [onActivate, project.path]);

  const handleClose = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onClose(project);
    },
    [onClose, project]
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu(project, event.clientX, event.clientY);
    },
    [onContextMenu, project]
  );

  const className = isActive ? 'project-rail-item is-active' : 'project-rail-item';

  // Per-project accent color, derived deterministically from the workspace
  // path so the rail icon matches the colored bar shown in the workspace
  // summary header (and in SessionHistory entries) for the same project.
  const accentColor = useMemo(() => generateWorkspaceAccentColor(project.path), [project.path]);

  // Inactive projects show a badge when something needs attention. Active
  // projects already have the user's eyes on them so we suppress the
  // badge to keep the rail quiet.
  const showBadge = !isActive && (processingCount > 0 || unreadCount > 0);
  const badgeLabel = processingCount > 0 ? `${processingCount}` : unreadCount > 0 ? `${unreadCount}` : '';

  // Wrapper is a non-interactive container so the activate button and the
  // close button can sit as siblings. Nesting a button inside a button is
  // invalid HTML and confuses screen readers / keyboard navigation.
  return (
    <div
      ref={tooltipRefs.setReference}
      className={className}
      onContextMenu={handleContextMenu}
      data-testid="project-rail-item"
      data-project-path={project.path}
      style={{ ['--rail-item-accent' as any]: accentColor }}
      {...getTooltipRefProps()}
    >
      <button
        type="button"
        className="project-rail-item-main"
        onClick={handleClick}
        aria-label={`Switch to project ${project.name}`}
        aria-current={isActive ? 'true' : undefined}
      >
        {projectInitials(project.name)}
        {showBadge && (
          <span
            className="project-rail-item-badge"
            aria-label={processingCount > 0 ? `${processingCount} streaming session(s)` : `${unreadCount} unread`}
          >
            {badgeLabel}
          </span>
        )}
      </button>
      <button
        type="button"
        className="project-rail-item-close"
        onClick={handleClose}
        aria-label={`Close ${project.name}`}
      >
        ×
      </button>
      {tooltipOpen && (
        <FloatingPortal>
          <div
            ref={tooltipRefs.setFloating}
            className="project-rail-tooltip"
            style={tooltipFloatingStyles}
            {...getTooltipFloatingProps()}
          >
            <span className="project-rail-tooltip-name">{project.name}</span>
            <span className="project-rail-tooltip-path">{project.path}</span>
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}

export function ProjectRail() {
  const isMultiProjectMode = useAtomValue(multiProjectModeAtom);
  const openProjects = useAtomValue(openProjectsAtom);
  const [activePath, setActivePath] = useAtom(activeWorkspacePathAtom);
  const atCap = useAtomValue(isOpenProjectsAtCapAtom);
  const addProject = useSetAtom(addOpenProjectAtom);
  const closeProject = useSetAtom(closeOpenProjectAtom);
  const activity = useAtomValue(globalSessionActivityAtom);
  const activitySummary = useAtomValue(projectActivitySummaryAtom);

  const handleActivate = useCallback(
    (path: string) => {
      if (path === activePath) return;
      // The atom subscriber in initOpenProjects() forwards the change to
      // the main process via `workspace:set-active`, so there is no direct
      // IPC call here.
      setActivePath(path);
    },
    [activePath, setActivePath]
  );

  const addProjectByPath = useCallback(async (workspacePath: string) => {
    if (!window.electronAPI?.invoke) return;
    try {
      const reg = await window.electronAPI.invoke('workspace:register-additional', { workspacePath });
      if (!reg?.success) {
        console.error('[ProjectRail] register-additional failed:', reg?.error);
        return;
      }

      const project: OpenProject = {
        path: workspacePath,
        name: workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath,
        openedAt: Date.now(),
      };
      // `addOpenProjectAtom` flips `activeWorkspacePathAtom` to this path;
      // the atom subscriber dispatches `workspace:set-active` to main.
      addProject(project);
    } catch (err) {
      console.error('[ProjectRail] addProjectByPath failed:', err);
    }
  }, [addProject]);

  const handlePickFolder = useCallback(async () => {
    if (!window.electronAPI?.invoke) return;
    try {
      const result = await window.electronAPI.invoke('dialog-show-open-dialog', {
        properties: ['openDirectory'],
        title: 'Open Project',
      });
      if (result?.canceled) return;
      const picked: string | undefined = result?.filePaths?.[0];
      if (!picked) return;
      await addProjectByPath(picked);
    } catch (err) {
      console.error('[ProjectRail] handlePickFolder failed:', err);
    }
  }, [addProjectByPath]);

  const refreshRecents = useCallback(async () => {
    if (!window.electronAPI?.invoke) return;
    try {
      const items = await window.electronAPI.invoke('settings:get-recent-projects') as Array<{ path: string; name: string; timestamp?: number }>;
      setRecentProjects(Array.isArray(items) ? items : []);
    } catch (err) {
      console.error('[ProjectRail] failed to load recents:', err);
    }
  }, []);

  const handleOpenAddMenu = useCallback(() => {
    if (atCap) {
      window.alert('You can have at most 8 projects open in the rail. Close one first or open in a new window.');
      return;
    }
    refreshRecents();
    setAddMenuOpen(true);
  }, [atCap, refreshRecents]);

  const handleClose = useCallback(
    async (project: OpenProject) => {
      // Warn if there are streaming sessions for this project. Read from the
      // cross-workspace activity tracker (kept in sync by sessionStateListeners
      // for every warm rail project) instead of `sessionRegistryAtom`, which
      // only carries the active project's sessions and would silently skip
      // the prompt when closing an inactive rail project.
      const streaming = activity.get(project.path)?.streaming.size ?? 0;
      if (streaming > 0) {
        const proceed = window.confirm(
          `${project.name} has ${streaming} streaming session${streaming === 1 ? '' : 's'}. Close anyway? Sessions will be paused.`
        );
        if (!proceed) return;
      }

      const wasLast = openProjects.length <= 1;

      closeProject(project.path);

      try {
        await window.electronAPI?.invoke?.('workspace:unregister-additional', { workspacePath: project.path });
      } catch (err) {
        console.error('[ProjectRail] unregister-additional failed:', err);
      }

      // Closing the last project leaves nothing to render in this window.
      // Ask the host to close the window so the app can fall back to its
      // initial project-selection flow.
      if (wasLast) {
        try {
          await window.electronAPI?.invoke?.('workspace:close-rail-window');
        } catch (err) {
          console.error('[ProjectRail] close-rail-window failed:', err);
        }
      }
    },
    [closeProject, activity, openProjects.length]
  );

  // Right-click context menu state. Anchored to a virtual reference at the
  // cursor position so it works for any rail icon without per-icon refs.
  const [menu, setMenu] = useState<{ project: OpenProject; x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // "Add project" dropdown — opens recents + folder picker action when the
  // user clicks the `+` button.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<Array<{ path: string; name: string; timestamp?: number }>>([]);
  const addButtonRef = React.useRef<HTMLButtonElement | null>(null);

  const {
    refs: addRefs,
    floatingStyles: addFloatingStyles,
    context: addContext,
  } = useFloating({
    open: addMenuOpen,
    onOpenChange: setAddMenuOpen,
    placement: 'right-end',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  });
  const addDismiss = useDismiss(addContext);
  const addRole = useRole(addContext, { role: 'menu' });
  const { getFloatingProps: getAddFloatingProps } = useInteractions([addDismiss, addRole]);

  // Hover tooltip for the add button. Separate floating-ui instance from
  // the click-driven add menu above; both share `addButtonRef` as the
  // anchor element.
  const [addTooltipOpen, setAddTooltipOpen] = useState(false);
  const {
    refs: addTooltipRefs,
    floatingStyles: addTooltipFloatingStyles,
    context: addTooltipContext,
  } = useFloating({
    open: addTooltipOpen,
    onOpenChange: setAddTooltipOpen,
    placement: 'right',
    middleware: [offset(12), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const addTooltipHover = useHover(addTooltipContext, { delay: { open: 200, close: 0 }, move: false });
  const { getReferenceProps: getAddTooltipRefProps, getFloatingProps: getAddTooltipFloatingProps } =
    useInteractions([addTooltipHover]);

  React.useEffect(() => {
    if (addButtonRef.current) {
      addRefs.setReference(addButtonRef.current);
      addTooltipRefs.setReference(addButtonRef.current);
    }
  }, [addRefs, addTooltipRefs]);

  const openProjectPaths = useMemo(() => new Set(openProjects.map((p) => p.path)), [openProjects]);
  const filteredRecents = useMemo(
    () => recentProjects.filter((r) => !openProjectPaths.has(r.path)).slice(0, 8),
    [recentProjects, openProjectPaths]
  );

  const { refs, floatingStyles, context } = useFloating({
    open: menu !== null,
    onOpenChange: (open) => {
      if (!open) closeMenu();
    },
    placement: 'right-start',
    middleware: [offset(4), flip(), shift({ padding: 8 })],
  });

  // Use a virtual reference at the cursor position. setPositionReference
  // accepts a VirtualElement which is the documented escape hatch.
  React.useEffect(() => {
    if (!menu) {
      refs.setPositionReference(null);
      return;
    }
    const virtual: VirtualElement = {
      getBoundingClientRect: () => DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }),
    };
    refs.setPositionReference(virtual);
  }, [menu, refs]);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'menu' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const handleContextMenu = useCallback((project: OpenProject, x: number, y: number) => {
    setMenu({ project, x, y });
  }, []);

  const handleOpenInNewWindow = useCallback(async (project: OpenProject) => {
    closeMenu();
    try {
      await window.electronAPI?.invoke?.('workspace-manager:open-workspace', project.path);
    } catch (err) {
      console.error('[ProjectRail] open-workspace failed:', err);
    }
  }, [closeMenu]);

  const handleRevealInFinder = useCallback(async (project: OpenProject) => {
    closeMenu();
    try {
      await window.electronAPI?.invoke?.('show-in-finder', project.path);
    } catch (err) {
      console.error('[ProjectRail] show-in-finder failed:', err);
    }
  }, [closeMenu]);

  if (!isMultiProjectMode) return null;

  return (
    <nav className="project-rail" data-testid="project-rail" aria-label="Open projects">
      {/* Epic H1: org switcher sits above the project switcher. */}
      <OrgSwitcher />
      {openProjects.map((project) => {
        const activity = activitySummary.get(project.path);
        return (
          <ProjectRailIcon
            key={project.path}
            project={project}
            isActive={project.path === activePath}
            processingCount={activity?.processing ?? 0}
            unreadCount={activity?.unread ?? 0}
            onActivate={handleActivate}
            onClose={handleClose}
            onContextMenu={handleContextMenu}
          />
        );
      })}
      {openProjects.length > 0 && <div className="project-rail-divider" aria-hidden="true" />}
      <button
        ref={addButtonRef}
        type="button"
        className="project-rail-add"
        onClick={handleOpenAddMenu}
        disabled={atCap}
        data-testid="project-rail-add"
        aria-label="Add project to rail"
        {...getAddTooltipRefProps()}
      >
        +
      </button>
      {addTooltipOpen && (
        <FloatingPortal>
          <div
            ref={addTooltipRefs.setFloating}
            className="project-rail-tooltip"
            style={addTooltipFloatingStyles}
            {...getAddTooltipFloatingProps()}
          >
            {atCap ? 'Rail full (8 projects max)' : 'Add project'}
          </div>
        </FloatingPortal>
      )}

      {addMenuOpen && (
        <FloatingPortal>
          <div
            ref={addRefs.setFloating}
            className="project-rail-context-menu project-rail-add-menu"
            style={addFloatingStyles}
            data-testid="project-rail-add-menu"
            {...getAddFloatingProps()}
          >
            <button
              type="button"
              className="project-rail-context-menu-item"
              onClick={() => {
                setAddMenuOpen(false);
                handlePickFolder();
              }}
            >
              Open folder…
            </button>
            {filteredRecents.length > 0 && (
              <>
                <div className="project-rail-context-menu-divider" />
                <div className="project-rail-context-menu-heading">Recent projects</div>
                {filteredRecents.map((recent) => (
                  <button
                    key={recent.path}
                    type="button"
                    className="project-rail-context-menu-item project-rail-context-menu-item-recent"
                    onClick={() => {
                      setAddMenuOpen(false);
                      addProjectByPath(recent.path);
                    }}
                    title={recent.path}
                  >
                    <span className="project-rail-context-menu-item-name">{recent.name || recent.path}</span>
                    <span className="project-rail-context-menu-item-path">{recent.path}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </FloatingPortal>
      )}

      {menu && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            className="project-rail-context-menu"
            style={floatingStyles}
            data-testid="project-rail-context-menu"
            {...getFloatingProps()}
          >
            <button
              type="button"
              className="project-rail-context-menu-item"
              onClick={() => handleOpenInNewWindow(menu.project)}
            >
              Open in new window
            </button>
            <button
              type="button"
              className="project-rail-context-menu-item"
              onClick={() => handleRevealInFinder(menu.project)}
            >
              {REVEAL_LABEL}
            </button>
            <div className="project-rail-context-menu-divider" />
            <button
              type="button"
              className="project-rail-context-menu-item"
              onClick={() => {
                closeMenu();
                handleClose(menu.project);
              }}
            >
              Close project
            </button>
          </div>
        </FloatingPortal>
      )}
    </nav>
  );
}
