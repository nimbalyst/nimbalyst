import { describe, it, expect, beforeEach } from 'vitest';
import {
  windowStates,
  resolveActiveWorkspacePath,
  resolveActiveWorkspacePathForWindowId,
  resolveDocumentServicePath,
  windowReferencesWorkspace,
  anyWindowReferencesWorkspace,
} from '../windowState';
import type { WindowState } from '../../types';

function makeState(partial: Partial<WindowState> = {}): WindowState {
  return {
    mode: 'workspace',
    filePath: null,
    workspacePath: null,
    documentEdited: false,
    ...partial,
  };
}

describe('windowState helpers', () => {
  beforeEach(() => {
    windowStates.clear();
  });

  describe('resolveActiveWorkspacePath', () => {
    it('returns null for an undefined state', () => {
      expect(resolveActiveWorkspacePath(undefined)).toBeNull();
    });

    it('returns the activeWorkspacePath when present', () => {
      const state = makeState({
        workspacePath: '/ws/primary',
        activeWorkspacePath: '/ws/active',
      });
      expect(resolveActiveWorkspacePath(state)).toBe('/ws/active');
    });

    it('falls back to workspacePath when activeWorkspacePath is missing', () => {
      const state = makeState({ workspacePath: '/ws/primary' });
      expect(resolveActiveWorkspacePath(state)).toBe('/ws/primary');
    });

    it('returns null when both are nullish', () => {
      expect(resolveActiveWorkspacePath(makeState())).toBeNull();
    });
  });

  describe('resolveActiveWorkspacePathForWindowId', () => {
    it('returns undefined for a null or undefined window id', () => {
      expect(resolveActiveWorkspacePathForWindowId(null)).toBeUndefined();
      expect(resolveActiveWorkspacePathForWindowId(undefined)).toBeUndefined();
    });

    it('returns undefined when no window state is registered for the id', () => {
      expect(resolveActiveWorkspacePathForWindowId(42)).toBeUndefined();
    });

    it('falls back to the primary workspacePath when no rail project is active', () => {
      windowStates.set(1, makeState({ workspacePath: '/ws/project1' }));
      expect(resolveActiveWorkspacePathForWindowId(1)).toBe('/ws/project1');
    });

    // Regression for issue #544: in Multi-Project mode the rail switches the
    // active project via activeWorkspacePath while workspacePath stays pinned
    // to the startup project. Resolution must honor the active project so an
    // automation/extension prompt creates its session in the visible project.
    it('returns the active rail project, not the startup primary (issue #544)', () => {
      windowStates.set(1, makeState({
        workspacePath: '/ws/project1',
        activeWorkspacePath: '/ws/project3',
      }));
      expect(resolveActiveWorkspacePathForWindowId(1)).toBe('/ws/project3');
    });
  });

  describe('resolveDocumentServicePath', () => {
    it('returns null for an undefined state', () => {
      expect(resolveDocumentServicePath(undefined)).toBeNull();
    });

    it('returns null for a non-workspace mode window', () => {
      const state = makeState({ mode: 'document', workspacePath: '/ws/a' });
      expect(resolveDocumentServicePath(state)).toBeNull();
    });

    it('serves the primary path when no rail project is active', () => {
      const state = makeState({ workspacePath: '/ws/a' });
      expect(resolveDocumentServicePath(state)).toBe('/ws/a');
    });

    it('allows agentic-coding windows', () => {
      const state = makeState({ mode: 'agentic-coding', workspacePath: '/ws/a' });
      expect(resolveDocumentServicePath(state)).toBe('/ws/a');
    });

    // Regression for issue #591: in Multi-Project mode the rail switches the
    // visible project via activeWorkspacePath while workspacePath stays pinned
    // to the startup project. The document-service resolver must serve the
    // ACTIVE project, otherwise tracker-items-list queries the wrong project's
    // tracker_items and leaks another project's items into the visible list.
    it('serves the active rail project, not the startup primary (issue #591)', () => {
      const state = makeState({
        workspacePath: '/ws/projectA',
        activeWorkspacePath: '/ws/projectB',
      });
      expect(resolveDocumentServicePath(state)).toBe('/ws/projectB');
    });
  });

  describe('windowReferencesWorkspace', () => {
    it('returns false for an undefined state', () => {
      expect(windowReferencesWorkspace(undefined, '/ws/a')).toBe(false);
    });

    it('matches the primary workspacePath', () => {
      const state = makeState({ workspacePath: '/ws/a' });
      expect(windowReferencesWorkspace(state, '/ws/a')).toBe(true);
    });

    it('matches a path in additionalWorkspacePaths', () => {
      const state = makeState({
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['/ws/b', '/ws/c'],
      });
      expect(windowReferencesWorkspace(state, '/ws/c')).toBe(true);
    });

    it('returns false for an unrelated path', () => {
      const state = makeState({
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['/ws/b'],
      });
      expect(windowReferencesWorkspace(state, '/ws/zzz')).toBe(false);
    });
  });

  describe('anyWindowReferencesWorkspace', () => {
    it('returns false when no windows are registered', () => {
      expect(anyWindowReferencesWorkspace('/ws/a')).toBe(false);
    });

    it('returns true when a single window references the path', () => {
      windowStates.set(1, makeState({ workspacePath: '/ws/a' }));
      expect(anyWindowReferencesWorkspace('/ws/a')).toBe(true);
    });

    it('finds matches in additionalWorkspacePaths across windows', () => {
      windowStates.set(1, makeState({ workspacePath: '/ws/a' }));
      windowStates.set(
        2,
        makeState({ workspacePath: '/ws/b', additionalWorkspacePaths: ['/ws/c'] })
      );
      expect(anyWindowReferencesWorkspace('/ws/c')).toBe(true);
    });

    it('respects excludeWindowId so callers can ignore self', () => {
      windowStates.set(1, makeState({ workspacePath: '/ws/a' }));
      windowStates.set(2, makeState({ workspacePath: '/ws/b' }));

      // Excluding the only window holding the path → no other refs.
      expect(anyWindowReferencesWorkspace('/ws/a', 1)).toBe(false);

      // Other windows still report a match for their primary paths.
      expect(anyWindowReferencesWorkspace('/ws/b', 1)).toBe(true);
    });

    it('returns true when the path is held only by additional refs in another window', () => {
      windowStates.set(1, makeState({ workspacePath: '/ws/main', additionalWorkspacePaths: ['/ws/shared'] }));
      windowStates.set(2, makeState({ workspacePath: '/ws/other', additionalWorkspacePaths: ['/ws/shared'] }));

      // Closing window 1: window 2 still references /ws/shared as warm.
      expect(anyWindowReferencesWorkspace('/ws/shared', 1)).toBe(true);
    });

    it('returns false when the only references are excluded', () => {
      windowStates.set(1, makeState({ workspacePath: '/ws/lone' }));
      expect(anyWindowReferencesWorkspace('/ws/lone', 1)).toBe(false);
    });
  });
});
