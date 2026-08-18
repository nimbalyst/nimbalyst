// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveProjectOpenTarget } from '../resolveProjectOpenTarget';

interface FakeWindow {
  id: string;
}

describe('resolveProjectOpenTarget', () => {
  it('focuses an existing window when the mode is off', () => {
    const existing: FakeWindow = { id: 'existing' };

    const result = resolveProjectOpenTarget({
      workspacePath: '/ws',
      multiProjectModeEnabled: false,
      existingWindowForPath: existing,
      focusedWorkspaceWindow: null,
    });

    expect(result).toEqual({ kind: 'focus-existing', window: existing });
  });

  it('opens a new window when the mode is off and nothing references the path', () => {
    const result = resolveProjectOpenTarget<FakeWindow>({
      workspacePath: '/ws',
      multiProjectModeEnabled: false,
      existingWindowForPath: null,
      focusedWorkspaceWindow: { id: 'focused' },
    });

    expect(result).toEqual({ kind: 'new-window' });
  });

  it('focuses an existing window even when the mode is on', () => {
    const existing: FakeWindow = { id: 'existing' };

    const result = resolveProjectOpenTarget({
      workspacePath: '/ws',
      multiProjectModeEnabled: true,
      existingWindowForPath: existing,
      focusedWorkspaceWindow: { id: 'focused' },
    });

    expect(result).toEqual({ kind: 'focus-existing', window: existing });
  });

  it('adds to the focused workspace window rail when the mode is on and no window has the path', () => {
    const focused: FakeWindow = { id: 'focused' };

    const result = resolveProjectOpenTarget({
      workspacePath: '/ws',
      multiProjectModeEnabled: true,
      existingWindowForPath: null,
      focusedWorkspaceWindow: focused,
    });

    expect(result).toEqual({ kind: 'add-to-rail', window: focused });
  });

  it('opens a new window when the mode is on but no workspace window is open at all', () => {
    const result = resolveProjectOpenTarget<FakeWindow>({
      workspacePath: '/ws',
      multiProjectModeEnabled: true,
      existingWindowForPath: null,
      focusedWorkspaceWindow: null,
    });

    expect(result).toEqual({ kind: 'new-window' });
  });
});
