import { describe, it, expect } from 'vitest';
import type { WindowState } from '../../types';
import {
  windowBindsWorkspace,
  selectPromptTargetWindowIds,
  canWindowResolvePrompt,
  type WindowForTargeting,
} from '../permissionPromptTargeting';

const WS = '/Users/me/project';
const OTHER = '/Users/me/other';

function state(partial: Partial<WindowState>): WindowState {
  return {
    mode: 'workspace',
    filePath: null,
    workspacePath: null,
    documentEdited: false,
    ...partial,
  };
}

function win(id: number, partial: Partial<WindowState>, focused = false): WindowForTargeting {
  return { id, state: state(partial), focused };
}

describe('windowBindsWorkspace', () => {
  it('matches the primary workspace path', () => {
    expect(windowBindsWorkspace(state({ workspacePath: WS }), WS)).toBe(true);
  });

  it('matches the active (rail-visible) path even when primary differs', () => {
    // The regression: rail active = WS, but primary is another project. The
    // old active-only logic worked here; keep it covered.
    expect(
      windowBindsWorkspace(state({ workspacePath: OTHER, activeWorkspacePath: WS }), WS)
    ).toBe(true);
  });

  it('matches an additional (background rail) path while a different project is active', () => {
    // The bug: WS is open in the window as a warm additional project, but the
    // active rail project is OTHER. Active-only matching dropped the prompt.
    expect(
      windowBindsWorkspace(
        state({ workspacePath: OTHER, activeWorkspacePath: OTHER, additionalWorkspacePaths: [WS] }),
        WS
      )
    ).toBe(true);
  });

  it('matches the primary path while a different project is active in the rail', () => {
    // The bug, second shape: WS is the window's primary, but the user switched
    // the rail to OTHER. resolveActiveWorkspacePath() returned OTHER, so the
    // prompt was dropped even though this window plainly hosts WS.
    expect(
      windowBindsWorkspace(state({ workspacePath: WS, activeWorkspacePath: OTHER }), WS)
    ).toBe(true);
  });

  it('does not match a window with no binding to the workspace', () => {
    expect(windowBindsWorkspace(state({ workspacePath: OTHER }), WS)).toBe(false);
    expect(windowBindsWorkspace(undefined, WS)).toBe(false);
  });
});

describe('selectPromptTargetWindowIds', () => {
  it('targets every window that binds the workspace, not just the active match', () => {
    const windows = [
      win(1, { workspacePath: WS, activeWorkspacePath: OTHER }), // primary WS, rail on OTHER
      win(2, { workspacePath: OTHER, additionalWorkspacePaths: [WS] }), // WS warm in rail
      win(3, { workspacePath: OTHER, activeWorkspacePath: OTHER }), // unrelated
    ];
    expect(selectPromptTargetWindowIds(windows, WS).sort()).toEqual([1, 2]);
  });

  it('falls back to the focused window when none bind the workspace (never drops the prompt)', () => {
    const windows = [
      win(1, { workspacePath: OTHER }, false),
      win(2, { workspacePath: OTHER }, true),
    ];
    expect(selectPromptTargetWindowIds(windows, WS)).toEqual([2]);
  });

  it('falls back to all windows when nothing binds and nothing is focused', () => {
    const windows = [win(1, { workspacePath: OTHER }), win(2, { workspacePath: OTHER })];
    expect(selectPromptTargetWindowIds(windows, WS).sort()).toEqual([1, 2]);
  });

  it('returns [] only when there are no windows', () => {
    expect(selectPromptTargetWindowIds([], WS)).toEqual([]);
  });
});

describe('canWindowResolvePrompt', () => {
  it('authorizes a window the prompt was delivered to', () => {
    expect(canWindowResolvePrompt([1, 2], 2)).toBe(true);
  });

  it('rejects a window the prompt was not delivered to (cross-workspace guard)', () => {
    expect(canWindowResolvePrompt([1, 2], 3)).toBe(false);
  });

  it('rejects a null sender window', () => {
    expect(canWindowResolvePrompt([1, 2], null)).toBe(false);
  });
});
