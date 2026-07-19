/**
 * ProjectTabs
 *
 * Horizontal tab strip of warm projects. Click a tab to switch
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
import { useAtom, useAtomValue } from 'jotai';
import { OrgSwitcher } from './OrgSwitcher';
import {
  multiProjectModeAtom,
  openProjectsAtom,
  activeWorkspacePathAtom,
  isOpenProjectsAtCapAtom,
  type OpenProject,
} from '../store/atoms/openProjects';
import { projectActivitySummaryAtom } from '../store/atoms/sessionActivity';
import { generateWorkspaceAccentColor } from './WorkspaceSummaryHeader';
import { errorNotificationService } from '../services/ErrorNotificationService';
import { flushTabsSlot, getTabsSlotTransferBlocker, persistTabsSlot } from '../contexts/TabsContext';
import {
  closeProjectTab,
  detachProjectTab,
  moveProjectTabToCurrentWindow,
  openProjectTab,
} from '../services/projectTabs';
import {
  hasProjectTabDragType,
  parseProjectTabDragPayload,
  serializeProjectTabDragPayload,
  shouldDetachProjectTabAfterDrag,
  waitForProjectTabPreparation,
} from './projectTabDrag';
import {
  PROJECT_TAB_DRAG_MIME,
  type ProjectTabDragPayload,
  type ProjectTabDragRegistration,
} from '../../shared/projectTabs';
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
  onNavigate: (project: OpenProject, key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End') => void;
  onClose: (project: OpenProject) => void;
  onDetach: (project: OpenProject, screenX: number, screenY: number) => void;
  onContextMenu: (project: OpenProject, x: number, y: number) => void;
}

function ProjectRailIcon({
  project,
  isActive,
  processingCount,
  unreadCount,
  onActivate,
  onNavigate,
  onClose,
  onDetach,
  onContextMenu,
}: ProjectRailIconProps) {
  const dragIdRef = React.useRef<string | null>(null);
  const dragPreparationRef = React.useRef<Promise<{ success: boolean; error?: string }> | null>(null);
  // Hover tooltip via floating-ui. Renders through FloatingPortal so the
  // tooltip escapes the rail container's `overflow: hidden` clip — the
  // earlier CSS-only `:hover > .project-rail-tooltip` approach was clipped
  // and never visible. Matches CLAUDE.md's floating-ui rule.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const { refs: tooltipRefs, floatingStyles: tooltipFloatingStyles, context: tooltipContext } = useFloating({
    open: tooltipOpen,
    onOpenChange: setTooltipOpen,
    placement: 'bottom',
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

  const handleDragStart = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const dragId = globalThis.crypto?.randomUUID?.()
      ?? `project-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload: ProjectTabDragPayload = {
      version: 1,
      dragId,
    };
    const registration: ProjectTabDragRegistration = { ...payload, workspacePath: project.path };
    dragIdRef.current = dragId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PROJECT_TAB_DRAG_MIME, serializeProjectTabDragPayload(payload));
    window.electronAPI?.send?.('workspace:begin-project-tab-drag', registration);
    dragPreparationRef.current = (async () => {
      try {
        // Moving removes this renderer's workspace slot. Flush buffers and
        // persist its file-tab layout before main commits the handoff so the
        // destination can restore it without losing unsaved work.
        await flushTabsSlot(project.path);
        const transferBlocker = getTabsSlotTransferBlocker(project.path);
        if (transferBlocker) throw new Error(transferBlocker);
        await persistTabsSlot(project.path);
        window.electronAPI?.send?.('workspace:project-tab-drag-ready', { dragId });
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.electronAPI?.send?.('workspace:project-tab-drag-ready', { dragId, error: message });
        return { success: false, error: message };
      }
    })();
    event.currentTarget.classList.add('is-dragging');
  }, [project.path]);

  const handleDragEnd = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.currentTarget.classList.remove('is-dragging');
    const dragId = dragIdRef.current;
    const preparation = dragPreparationRef.current;
    dragIdRef.current = null;
    dragPreparationRef.current = null;

    // A project rail accepted this drop. Main owns the move transaction and
    // will publish mutations to both renderers, so the source must not also
    // run its tear-out path and create a third window.
    if (event.dataTransfer.dropEffect === 'move') return;

    const strip = event.currentTarget.closest('.project-rail')?.getBoundingClientRect();
    if (!strip) {
      if (dragId) window.electronAPI?.send?.('workspace:end-project-tab-drag', { dragId });
      return;
    }

    const shouldDetach = shouldDetachProjectTabAfterDrag({
      clientX: event.clientX,
      clientY: event.clientY,
      dropEffect: event.dataTransfer.dropEffect,
    }, strip);
    if (!shouldDetach) {
      if (dragId) window.electronAPI?.send?.('workspace:end-project-tab-drag', { dragId });
      return;
    }

    const { screenX, screenY } = event;
    void (async () => {
      // A Linux dragend can occasionally report dropEffect=none even though
      // another BrowserWindow accepted the drop. Give that atomic move a
      // brief chance to settle before creating a detached window.
      let result: { handled?: boolean; moved?: boolean } | null = null;
      try {
        result = dragId
          ? await window.electronAPI?.invoke?.('workspace:wait-project-tab-drag-result', { dragId })
          : null;
      } catch (error) {
        console.error('[ProjectTabs] failed to resolve project-tab drag:', error);
      }
      if (result?.handled || result?.moved) return;

      const prepared = await waitForProjectTabPreparation(preparation);
      if (prepared && !prepared.success) {
        errorNotificationService.showWarning(
          'Project tab was not moved',
          prepared.error || 'The project could not be saved before moving.',
          { duration: 8000 },
        );
        return;
      }
      onDetach(project, screenX, screenY);
    })();
  }, [onDetach, project]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (
      event.key === 'ArrowLeft'
      || event.key === 'ArrowRight'
      || event.key === 'Home'
      || event.key === 'End'
    ) {
      event.preventDefault();
      onNavigate(project, event.key);
    }
  }, [onNavigate, project]);

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
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      data-testid="project-rail-item"
      data-project-path={project.path}
      style={{ ['--rail-item-accent' as any]: accentColor }}
      {...getTooltipRefProps()}
    >
      <button
        type="button"
        className="project-rail-item-main"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role="tab"
        aria-label={`Switch to project ${project.name}`}
        aria-selected={isActive}
        tabIndex={isActive ? 0 : -1}
      >
        <span className="project-rail-item-icon" aria-hidden="true">
          {projectInitials(project.name)}
        </span>
        <span className="project-rail-item-name">{project.name}</span>
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
  const activitySummary = useAtomValue(projectActivitySummaryAtom);
  const [isProjectTabDropTarget, setIsProjectTabDropTarget] = useState(false);

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

  const handleNavigate = useCallback((
    project: OpenProject,
    key: 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End',
  ) => {
    const index = openProjects.findIndex((entry) => entry.path === project.path);
    if (index < 0 || openProjects.length === 0) return;

    let targetIndex = index;
    if (key === 'ArrowLeft') targetIndex = (index - 1 + openProjects.length) % openProjects.length;
    if (key === 'ArrowRight') targetIndex = (index + 1) % openProjects.length;
    if (key === 'Home') targetIndex = 0;
    if (key === 'End') targetIndex = openProjects.length - 1;

    const target = openProjects[targetIndex];
    handleActivate(target.path);
    requestAnimationFrame(() => {
      const item = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="project-rail-item"]'),
      ).find((element) => element.dataset.projectPath === target.path);
      item?.querySelector<HTMLButtonElement>('[role="tab"]')?.focus();
    });
  }, [handleActivate, openProjects]);

  const addProjectByPath = useCallback(async (workspacePath: string) => {
    const result = await openProjectTab(workspacePath);
    if (!result.success) {
      console.error('[ProjectTabs] addProjectByPath failed:', result.error);
    }
  }, []);

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
      window.alert('You can have at most 8 project tabs open. Close one first or open it in a new window.');
      return;
    }
    refreshRecents();
    setAddMenuOpen(true);
  }, [atCap, refreshRecents]);

  const handleClose = useCallback(
    async (project: OpenProject) => {
      const result = await closeProjectTab(project.path);
      if (!result.success && result.error !== 'cancelled') {
        console.error('[ProjectTabs] close failed:', result.error);
      }
    },
    []
  );

  const handleDetach = useCallback(async (project: OpenProject, screenX: number, screenY: number) => {
    const result = await detachProjectTab(project.path, { screenX, screenY });
    if (!result.success) console.error('[ProjectTabs] detach failed:', result.error);
  }, []);

  const handleProjectTabDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasProjectTabDragType(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setIsProjectTabDropTarget(true);
  }, []);

  const handleProjectTabDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setIsProjectTabDropTarget(false);
  }, []);

  const handleProjectTabDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasProjectTabDragType(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setIsProjectTabDropTarget(false);

    // DataTransfer contents must be read synchronously during the drop event.
    const payload = parseProjectTabDragPayload(event.dataTransfer.getData(PROJECT_TAB_DRAG_MIME));
    if (!payload) return;
    void moveProjectTabToCurrentWindow(payload).then((result) => {
      if (!result.success) {
        errorNotificationService.showWarning(
          'Project tab was not moved',
          result.error || 'The destination window could not accept this project.',
          { duration: 8000 },
        );
      }
    });
  }, []);

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
    placement: 'bottom-end',
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
    placement: 'bottom',
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
    placement: 'bottom-start',
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
      await window.electronAPI?.invoke?.(
        'workspace-manager:open-workspace',
        project.path,
        { forceNewWindow: true },
      );
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
    <nav className="project-rail" data-testid="project-rail" aria-label="Open project tabs">
      {/* Org switcher leads the project tabs when team organizations exist. */}
      <OrgSwitcher />
      <div
        className={isProjectTabDropTarget ? 'project-rail-tabs is-drop-target' : 'project-rail-tabs'}
        role="tablist"
        aria-label="Projects"
        onDragEnter={handleProjectTabDragOver}
        onDragOver={handleProjectTabDragOver}
        onDragLeave={handleProjectTabDragLeave}
        onDrop={handleProjectTabDrop}
      >
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
              onNavigate={handleNavigate}
              onClose={handleClose}
              onDetach={handleDetach}
              onContextMenu={handleContextMenu}
            />
          );
        })}
      </div>
      <button
        ref={addButtonRef}
        type="button"
        className="project-rail-add"
        onClick={handleOpenAddMenu}
        disabled={atCap}
        data-testid="project-rail-add"
        aria-label="Open project tab"
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
            {atCap ? 'Tab strip full (8 projects max)' : 'Open project tab'}
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
