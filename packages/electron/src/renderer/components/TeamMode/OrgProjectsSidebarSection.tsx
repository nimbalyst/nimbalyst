import React, { useCallback, useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import { HelpTooltip } from '../../help';
import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';

export interface OrgProjectLocalState {
  projectId: string;
  teamProjectId: string;
  name: string | null;
  slug: string | null;
  gitRemoteHash: string | null;
  localStatus: 'open' | 'closed' | 'notLocal';
  workspacePath: string | null;
}

export function useOrgProjectLocalStates(orgId: string): {
  projects: OrgProjectLocalState[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [projects, setProjects] = useState<OrgProjectLocalState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.electronAPI.team.resolveOrgProjectsLocalState(orgId)
      .then((result) => {
        if (cancelled) return;
        if (!result?.success) throw new Error(result?.error ?? 'Could not load projects');
        setProjects(result.projects ?? []);
      })
      .catch((reason) => {
        if (!cancelled) {
          setProjects([]);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [orgId, nonce]);

  // Stable: the sidebar is memoized around this section, and a fresh `reload`
  // closure on every render would invalidate it on every navigation.
  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { projects, loading, error, reload };
}

export function resolveConversationProjectWorkspace(
  projects: readonly OrgProjectLocalState[],
  entry: ConversationDirectoryEntry,
): string | null {
  const projectHint = (entry as ConversationDirectoryEntry & {
    projectId?: string | null;
    teamProjectId?: string | null;
  }).projectId ?? (entry as ConversationDirectoryEntry & {
    teamProjectId?: string | null;
  }).teamProjectId ?? null;
  if (!projectHint) return null;
  const project = projects.find((candidate) => (
    candidate.projectId === projectHint || candidate.teamProjectId === projectHint
  ));
  if (!project || project.localStatus === 'notLocal') return null;
  return project.workspacePath;
}

export function OrgProjectsSidebarSection({
  orgId,
  projects,
  loading,
  error,
  onReload,
}: {
  orgId: string;
  projects: OrgProjectLocalState[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
}) {
  const openProject = useCallback((workspacePath: string | null) => {
    if (!workspacePath) return;
    void window.electronAPI.team.openProjectWorkspace(workspacePath).catch((reason) => {
      console.error('[OrgProjectsSidebarSection] Failed to open project:', reason);
    });
  }, []);

  return (
    // A section of the sidebar rather than a panel pinned under it: Projects
    // scrolls with Rooms, Direct messages and Admin instead of permanently
    // taking the bottom of the window.
    <section
      className="org-projects-sidebar-section"
      data-testid="org-projects-sidebar-section"
      data-component="OrgProjectsSidebarSection"
      data-org-id={orgId}
    >
      <div className="org-projects-sidebar-heading mt-2 flex items-center gap-1 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">
        <span className="min-w-0 flex-1 truncate">Projects</span>
        {error && (
          <button
            type="button"
            className="org-projects-sidebar-retry org-window-no-drag rounded px-1 text-[11px] normal-case tracking-normal text-[var(--nim-link)] hover:bg-[var(--nim-bg-hover)]"
            data-testid="org-projects-sidebar-retry"
            onClick={onReload}
          >
            Retry
          </button>
        )}
      </div>
      <div className="org-projects-sidebar-list flex flex-col" data-testid="org-projects-sidebar-list">
        {loading && (
          <div className="org-projects-sidebar-loading px-3 py-1 text-[11px] text-[var(--nim-text-muted)]">
            Loading projects…
          </div>
        )}
        {!loading && !error && projects.length === 0 && (
          <div className="org-projects-sidebar-empty px-3 py-1 text-[11px] text-[var(--nim-text-muted)]">
            No projects yet.
          </div>
        )}
        {!loading && error && (
          <div className="org-projects-sidebar-error px-3 py-1 text-[11px] text-[var(--nim-error)]">
            Couldn't load projects.
          </div>
        )}
        {!loading && !error && projects.map((project) => (
          <ProjectRow
            key={project.projectId}
            project={project}
            onOpen={openProject}
          />
        ))}
      </div>
    </section>
  );
}

function ProjectRow({
  project,
  onOpen,
}: {
  project: OrgProjectLocalState;
  onOpen: (workspacePath: string | null) => void;
}) {
  const name = project.name || project.slug || 'Untitled project';
  const disabled = project.localStatus === 'notLocal' || !project.workspacePath;
  const label = project.localStatus === 'open'
    ? 'Open locally'
    : project.localStatus === 'closed'
      ? 'Cloned locally'
      : 'Not local';
  const dotClass = project.localStatus === 'open'
    ? 'bg-[var(--nim-success)] border-[var(--nim-success)]'
    : project.localStatus === 'closed'
      ? 'bg-transparent border-[var(--nim-success)]'
      : 'bg-transparent border-[var(--nim-text-faint)] border-dashed';

  const button = (
    <button
      type="button"
      className={`org-projects-sidebar-row org-window-no-drag group flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left ${
        disabled
          ? 'cursor-not-allowed text-[var(--nim-text-disabled)]'
          : 'text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]'
      }`}
      data-testid="org-projects-sidebar-row"
      data-project-id={project.projectId}
      data-local-status={project.localStatus}
      disabled={disabled}
      title={disabled ? 'Clone flow is not available in this slice.' : label}
      onClick={() => onOpen(project.workspacePath)}
    >
      <span className={`org-projects-sidebar-dot size-2 shrink-0 rounded-full border ${dotClass}`} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px]">{name}</span>
        {project.localStatus === 'notLocal' && (
          <span className="block truncate text-[10px] text-[var(--nim-text-faint)]">not local</span>
        )}
      </span>
      {/* Revealed on hover/focus: the affordance is the same on every row, so
          showing it always was just noise down the list. */}
      {!disabled && (
        <MaterialSymbol
          icon="open_in_new"
          size={13}
          className="org-projects-sidebar-open shrink-0 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
        />
      )}
    </button>
  );

  if (!disabled) return button;

  return (
    <HelpTooltip testId={`org-project-not-local-${project.projectId}`}>
      <span className="org-projects-sidebar-row-disabled block">
        {button}
      </span>
    </HelpTooltip>
  );
}
