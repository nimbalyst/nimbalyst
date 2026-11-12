// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeTabIdAtom,
  makeEditorContext,
  store,
  type EditorKey,
} from '@nimbalyst/runtime/store';
import { activeSessionIdAtom } from '../../atoms/sessions';
import { windowModeAtom } from '../../atoms/windowMode';
import { buildVoiceUiContextResponse, getCurrentVoiceFilePath } from '../voiceModeListeners';
import { activeWorkspacePathAtom, openProjectsAtom } from '../../atoms/openProjects';
import { voiceActiveSessionIdAtom, voiceWorkspacePathAtom } from '../../atoms/voiceModeState';

afterEach(() => {
  store.set(windowModeAtom, 'files');
  store.set(activeSessionIdAtom, null);
  store.set(activeTabIdAtom('main'), null);
});

describe('getCurrentVoiceFilePath', () => {
  it('reads the active file-editor tab from renderer state', () => {
    store.set(windowModeAtom, 'files');
    store.set(
      activeTabIdAtom('main'),
      'main:/workspace/project/src/App.tsx' as EditorKey,
    );

    expect(getCurrentVoiceFilePath()).toBe('/workspace/project/src/App.tsx');
  });

  it('reads the active session editor tab while Agent view is selected', () => {
    const sessionId = 'session-123';
    store.set(windowModeAtom, 'agent');
    store.set(activeSessionIdAtom, sessionId);
    store.set(
      activeTabIdAtom(makeEditorContext(sessionId)),
      `session:${sessionId}:/workspace/project/src/agent.ts` as EditorKey,
    );

    expect(getCurrentVoiceFilePath()).toBe('/workspace/project/src/agent.ts');
  });

  it('does not expose a stale file tab from non-editor views', () => {
    store.set(windowModeAtom, 'settings');
    store.set(
      activeTabIdAtom('main'),
      'main:/workspace/project/src/App.tsx' as EditorKey,
    );

    expect(getCurrentVoiceFilePath()).toBeNull();
  });
});

describe('buildVoiceUiContextResponse', () => {
  afterEach(() => {
    store.set(voiceActiveSessionIdAtom, null);
    store.set(voiceWorkspacePathAtom, null);
  });

  // Voice runs in project B; the user switched the rail to project A. The
  // active session and file on screen are A's, not B's.
  it('refuses to report another rail project\'s screen as the voice project\'s', () => {
    store.set(openProjectsAtom, [
      { path: '/projects/a', name: 'a', openedAt: 0 },
      { path: '/projects/b', name: 'b', openedAt: 0 },
    ]);
    store.set(activeWorkspacePathAtom, '/projects/a');
    store.set(voiceActiveSessionIdAtom, 'voice-1');
    store.set(voiceWorkspacePathAtom, '/projects/b');
    store.set(windowModeAtom, 'agent');
    store.set(activeSessionIdAtom, 'session-in-a');

    const response = buildVoiceUiContextResponse({ workspacePath: '/projects/b', resultChannel: 'r' });

    expect(response.context).toBeUndefined();
    expect(response.error).toMatch(/another project/);
  });
});
