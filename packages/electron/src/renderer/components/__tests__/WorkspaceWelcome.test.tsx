// @vitest-environment jsdom

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceWelcome } from '../WorkspaceWelcome';

vi.mock('../../tips/FilesEmptyTipDisplay', () => ({
  FilesEmptyTipDisplay: () => <div data-testid="files-empty-tip-display" />,
}));

describe('WorkspaceWelcome', () => {
  afterEach(cleanup);

  it('keeps the no-workspace state to the icon and title', () => {
    render(<WorkspaceWelcome workspaceName="Open a workspace to get started" />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Open a workspace to get started',
    );
    expect(screen.queryByText('Files are saved automatically as you work')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create a new file' })).toBeNull();
    expect(screen.queryByTestId('files-empty-tip-display')).toBeNull();
  });

  it('renders workspace actions and routes card and chip interactions', () => {
    const onNewFile = vi.fn();
    const onFocusAgent = vi.fn();
    const onInsertAgentPrompt = vi.fn();

    render(
      <WorkspaceWelcome
        workspaceName="stravu-editor"
        hasWorkspace={true}
        workspacePath="/workspace"
        onNewFile={onNewFile}
        onFocusAgent={onFocusAgent}
        onInsertAgentPrompt={onInsertAgentPrompt}
      />,
    );

    expect(screen.getByText('Files are saved automatically as you work')).toBeTruthy();
    expect(screen.getByTestId('files-empty-tip-display')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create a new file' }));
    expect(onNewFile).toHaveBeenCalledWith();

    fireEvent.click(screen.getByRole('button', { name: 'Mockup' }));
    expect(onNewFile).toHaveBeenLastCalledWith('mockup');

    fireEvent.click(screen.getByRole('button', { name: 'Focus the agent chat' }));
    expect(onFocusAgent).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Summarize this project' }));
    expect(onInsertAgentPrompt).toHaveBeenCalledWith('Summarize this project');
    expect(onFocusAgent).toHaveBeenCalledTimes(1);
  });
});
