// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgProjectsSidebarSection, type OrgProjectLocalState } from '../OrgProjectsSidebarSection';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));
vi.mock('../../../help', () => ({
  HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function project(overrides: Partial<OrgProjectLocalState> = {}): OrgProjectLocalState {
  return {
    projectId: 'p-1',
    teamProjectId: 'tp-1',
    name: 'Notes',
    slug: 'notes',
    gitRemoteHash: null,
    localStatus: 'notLocal',
    workspacePath: null,
    ...overrides,
  };
}

function renderSection(projects: OrgProjectLocalState[]) {
  const onReload = vi.fn();
  render(
    <OrgProjectsSidebarSection
      orgId="org-1"
      projects={projects}
      loading={false}
      error={null}
      onReload={onReload}
    />,
  );
  return { onReload };
}

describe('OrgProjectsSidebarSection', () => {
  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
  });

  // A project with no git remote has nothing to match this machine by, so
  // opening it means choosing the folder it should live in.
  it('attaches a chosen folder to a project that has no git remote', async () => {
    const openSharedProject = vi.fn(async () => ({ success: true }));
    (window as any).electronAPI = {
      invoke: vi.fn(async () => ({ canceled: false, filePaths: ['/projects/notes'] })),
      team: { openSharedProject, openProjectWorkspace: vi.fn() },
    };
    const { onReload } = renderSection([project()]);

    fireEvent.click(screen.getByTestId('org-projects-sidebar-row'));

    await waitFor(() => expect(openSharedProject).toHaveBeenCalledWith({
      orgId: 'org-1',
      teamProjectId: 'tp-1',
      directoryPath: '/projects/notes',
    }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it('does not attach anything when the folder picker is dismissed', async () => {
    const openSharedProject = vi.fn();
    (window as any).electronAPI = {
      invoke: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      team: { openSharedProject, openProjectWorkspace: vi.fn() },
    };
    renderSection([project()]);

    fireEvent.click(screen.getByTestId('org-projects-sidebar-row'));

    await waitFor(() => expect((window as any).electronAPI.invoke).toHaveBeenCalled());
    expect(openSharedProject).not.toHaveBeenCalled();
  });

  it('surfaces the reason a folder was rejected', async () => {
    (window as any).electronAPI = {
      invoke: vi.fn(async () => ({ canceled: false, filePaths: ['/projects/taken'] })),
      team: {
        openSharedProject: vi.fn(async () => ({
          success: false,
          error: 'That folder already belongs to a different project',
        })),
        openProjectWorkspace: vi.fn(),
      },
    };
    renderSection([project()]);

    fireEvent.click(screen.getByTestId('org-projects-sidebar-row'));

    await waitFor(() => expect(
      screen.getByTestId('org-projects-sidebar-open-error').textContent,
    ).toContain('different project'));
  });

  // Binding an arbitrary folder to a repo-backed project would give it two
  // answers: the remote match and the binding. Cloning is the only way in.
  it('leaves a repo-backed project that is not on this machine disabled', () => {
    (window as any).electronAPI = {
      invoke: vi.fn(),
      team: { openSharedProject: vi.fn(), openProjectWorkspace: vi.fn() },
    };
    renderSection([project({ gitRemoteHash: 'hash-widgets' })]);

    const row = screen.getByTestId('org-projects-sidebar-row') as HTMLButtonElement;
    expect(row.disabled).toBe(true);

    fireEvent.click(row);
    expect((window as any).electronAPI.invoke).not.toHaveBeenCalled();
  });

  it('opens a project that is already on this machine without asking for a folder', () => {
    const openProjectWorkspace = vi.fn(async () => ({ success: true }));
    (window as any).electronAPI = {
      invoke: vi.fn(),
      team: { openSharedProject: vi.fn(), openProjectWorkspace },
    };
    renderSection([project({ localStatus: 'closed', workspacePath: '/projects/notes' })]);

    fireEvent.click(screen.getByTestId('org-projects-sidebar-row'));

    expect(openProjectWorkspace).toHaveBeenCalledWith('/projects/notes');
    expect((window as any).electronAPI.invoke).not.toHaveBeenCalled();
  });
});
