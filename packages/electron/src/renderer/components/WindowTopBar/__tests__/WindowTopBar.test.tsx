// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WindowTopBar } from '../WindowTopBar';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => (
    <span data-icon={icon} aria-hidden="true">{icon}</span>
  ),
}));

afterEach(() => cleanup());

describe('WindowTopBar', () => {
  it('renders stable markers, workspace identity, and active mode', () => {
    render(
      <WindowTopBar
        workspaceName="Timely Nebula"
        activeModeLabel="Shared Docs"
        gitStatus={null}
        gitActions={{
          onPull: () => {},
          onPush: () => {},
          onOpenLog: () => {},
        }}
      />,
    );

    const root = screen.getByTestId('window-top-bar');
    expect(root.classList.contains('window-top-bar')).toBe(true);
    expect(root.getAttribute('data-component')).toBe('WindowTopBar');
    expect(root.getAttribute('style')).toContain('height: 38px');
    expect(screen.getByTestId('window-top-bar-workspace-name').textContent).toBe('Timely Nebula');
    expect(screen.getByTestId('window-top-bar-mode-label').textContent).toBe('Shared Docs');
    expect(screen.queryByTestId('window-top-bar-git-status')).toBeNull();
    expect(screen.queryByTestId('window-top-bar-git-slot')).toBeNull();
  });

  it('renders branch, dirty, ahead, and behind state from explicit props', () => {
    render(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Files"
        gitStatus={{
          branch: 'feature/custom-title-bar',
          hasUncommitted: true,
          ahead: 2,
          behind: 3,
        }}
        gitActions={{
          onPull: () => {},
          onPush: () => {},
          onOpenLog: () => {},
        }}
      />,
    );

    const git = screen.getByTestId('window-top-bar-git-status');
    expect(git.textContent).toContain('feature/custom-title-bar');
    expect(git.textContent).toContain('Modified');
    expect(git.textContent).toContain('2');
    expect(git.textContent).toContain('3');
    expect(git.querySelector('[data-icon="arrow_upward"]')).not.toBeNull();
    expect(git.querySelector('[data-icon="arrow_downward"]')).not.toBeNull();
    expect(git.getAttribute('title')).toContain('feature/custom-title-bar');
  });

  it('places git between the project identity and the far-right actions', () => {
    render(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Files"
        gitStatus={{ branch: 'main', hasUncommitted: false, ahead: 1, behind: 0 }}
        gitActions={{
          onPull: () => {},
          onPush: () => {},
          onOpenLog: () => {},
        }}
        newSessionControl={{ label: 'New AI session', onCreate: () => {} }}
        panelControls={{
          right: { label: 'AI chat', collapsed: true, onToggle: () => {} },
        }}
      />,
    );

    const gitSlot = screen.getByTestId('window-top-bar-git-slot');
    const rightActions = screen.getByTestId('window-top-bar-right-actions');
    expect(screen.getByTestId('window-top-bar-git-status').parentElement).toBe(gitSlot);
    expect(screen.getByTestId('window-top-bar-new-session').parentElement).toBe(rightActions);
    expect(screen.getByTestId('window-top-bar-right-pane').parentElement).toBe(rightActions);
    expect(
      gitSlot.compareDocumentPosition(rightActions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('omits pane buttons when the active mode exposes no capabilities', () => {
    render(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Tracker"
        gitStatus={null}
        gitActions={{
          onPull: () => {},
          onPush: () => {},
          onOpenLog: () => {},
        }}
      />,
    );

    expect(screen.queryByTestId('window-top-bar-left-pane')).toBeNull();
    expect(screen.queryByTestId('window-top-bar-right-pane')).toBeNull();
  });

  it('calls supplied pane actions once and marks every interactive target no-drag', () => {
    const onToggleLeft = vi.fn();
    const onToggleRight = vi.fn();
    render(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Files"
        gitStatus={{ branch: 'main', hasUncommitted: false, ahead: 0, behind: 0 }}
        gitActions={{
          onPull: () => {},
          onPush: () => {},
          onOpenLog: () => {},
        }}
        panelControls={{
          left: { label: 'Files sidebar', collapsed: false, onToggle: onToggleLeft },
          right: { label: 'AI chat', collapsed: true, onToggle: onToggleRight },
        }}
      />,
    );

    const git = screen.getByTestId('window-top-bar-git-status');
    const left = screen.getByTestId('window-top-bar-left-pane');
    const right = screen.getByTestId('window-top-bar-right-pane');
    for (const target of [git, left, right]) {
      expect(target.classList.contains('window-top-bar__no-drag')).toBe(true);
    }

    fireEvent.click(left);
    fireEvent.click(right);

    expect(onToggleLeft).toHaveBeenCalledTimes(1);
    expect(onToggleRight).toHaveBeenCalledTimes(1);
    expect(left.getAttribute('aria-label')).toBe('Hide Files sidebar');
    expect(right.getAttribute('aria-label')).toBe('Show AI chat');
  });

  it('opens git actions from the intermediate status control', () => {
    const onPull = vi.fn();
    const onPush = vi.fn();
    const onOpenLog = vi.fn();
    render(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Files"
        gitStatus={{ branch: 'main', hasUncommitted: false, ahead: 1, behind: 2 }}
        gitActions={{ onPull, onPush, onOpenLog }}
      />,
    );

    fireEvent.click(screen.getByTestId('window-top-bar-git-status'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pull' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Push' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Git Log' }));

    expect(onPull).toHaveBeenCalledTimes(1);
    expect(onPush).toHaveBeenCalledTimes(1);
    expect(onOpenLog).toHaveBeenCalledTimes(1);
  });

  it('links to extension settings when Git Log is unavailable', () => {
    const onOpenLog = vi.fn();
    const onOpenExtensionSettings = vi.fn();
    render(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Files"
        gitStatus={{ branch: 'main', hasUncommitted: false, ahead: 0, behind: 0 }}
        gitActions={{
          onPull: () => {},
          onPush: () => {},
          onOpenLog,
          onOpenExtensionSettings,
          gitLogAvailable: false,
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('window-top-bar-git-status'));
    expect(
      (screen.getByRole('menuitem', { name: 'Open Git Log' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Enable Git Extension…' }));

    expect(onOpenLog).not.toHaveBeenCalled();
    expect(onOpenExtensionSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('window-top-bar-git-menu')).toBeNull();
  });

  it('moves the chat new-session action into the title bar', () => {
    const onCreate = vi.fn();
    render(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Files"
        gitStatus={null}
        gitActions={{
          onPull: () => {},
          onPush: () => {},
          onOpenLog: () => {},
        }}
        newSessionControl={{ label: 'New AI session', onCreate }}
      />,
    );

    fireEvent.click(screen.getByTestId('window-top-bar-new-session'));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('selects an Agent right-panel mode from the window top-bar dropdown', () => {
    const onChat = vi.fn();
    render(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Agent"
        gitStatus={null}
        gitActions={{
          onPull: () => {},
          onPush: () => {},
          onOpenLog: () => {},
        }}
        panelControls={{
          right: {
            label: 'Agent right panel',
            collapsed: false,
            onToggle: () => {},
            options: [
              {
                id: 'hidden',
                label: 'Hidden',
                icon: 'dock_to_left',
                selected: false,
                onSelect: () => {},
              },
              {
                id: 'edited-files',
                label: 'Edited Files',
                icon: 'description',
                selected: true,
                onSelect: () => {},
              },
              {
                id: 'review',
                label: 'Review',
                icon: 'rate_review',
                selected: false,
                onSelect: () => {},
              },
              {
                id: 'session-chat',
                label: 'Chat with Session',
                icon: 'forum',
                selected: false,
                onSelect: onChat,
              },
            ],
          },
        }}
      />,
    );

    fireEvent.click(screen.getByTestId('window-top-bar-right-pane'));
    expect(screen.getByRole('menuitem', { name: 'Edited Files' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Review' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Chat with Session' }));
    expect(onChat).toHaveBeenCalledTimes(1);
  });
});
