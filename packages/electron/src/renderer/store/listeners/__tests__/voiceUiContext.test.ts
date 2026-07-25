import { afterEach, describe, expect, it } from 'vitest';
import {
  activeTabIdAtom,
  makeEditorContext,
  store,
  type EditorKey,
} from '@nimbalyst/runtime/store';
import { activeSessionIdAtom } from '../../atoms/sessions';
import { windowModeAtom } from '../../atoms/windowMode';
import { getCurrentVoiceFilePath } from '../voiceModeListeners';

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
