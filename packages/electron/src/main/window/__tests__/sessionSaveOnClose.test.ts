import { describe, it, expect } from 'vitest';
import { shouldSaveSessionOnWindowClose } from '../sessionSaveOnClose';

describe('shouldSaveSessionOnWindowClose', () => {
  // NIM-1518: during a normal quit, before-quit has already saved the full
  // session state. The per-window close handler must NOT re-save as windows
  // tear down, or the last close persists `{ windows: [] }` and the next
  // launch restores no projects.
  it('does not re-save session state while the app is quitting', () => {
    expect(
      shouldSaveSessionOnWindowClose({ isQuitting: true, isRestarting: false })
    ).toBe(false);
  });

  it('does not re-save session state during a restart (NIM-869)', () => {
    expect(
      shouldSaveSessionOnWindowClose({ isQuitting: true, isRestarting: true })
    ).toBe(false);
    expect(
      shouldSaveSessionOnWindowClose({ isQuitting: false, isRestarting: true })
    ).toBe(false);
  });

  it('re-saves when the user closes a single window mid-session', () => {
    expect(
      shouldSaveSessionOnWindowClose({ isQuitting: false, isRestarting: false })
    ).toBe(true);
  });

  // Reproduces the NIM-1518 wipe end-to-end at the decision level: three
  // windows, before-quit saves all of them, then Electron closes each window.
  // With the guard, the persisted state must still hold all three windows
  // after teardown; without it, the last close persists an empty list.
  it('keeps the before-quit snapshot intact while windows tear down during quit', () => {
    const windowStates = new Map<number, { workspacePath: string }>([
      [1, { workspacePath: '/ws/a' }],
      [2, { workspacePath: '/ws/b' }],
      [3, { workspacePath: '/ws/c' }],
    ]);
    let persisted: string[] = [];
    const saveSessionState = () => {
      persisted = [...windowStates.values()].map((s) => s.workspacePath);
    };

    // before-quit: full save while all windows are alive
    const isQuitting = true;
    saveSessionState();
    expect(persisted).toEqual(['/ws/a', '/ws/b', '/ws/c']);

    // Electron closes each window; the close handler deletes its state entry
    // and only re-saves when the decision allows it.
    for (const windowId of [1, 2, 3]) {
      windowStates.delete(windowId);
      if (shouldSaveSessionOnWindowClose({ isQuitting, isRestarting: false })) {
        saveSessionState();
      }
    }

    expect(persisted).toEqual(['/ws/a', '/ws/b', '/ws/c']);
  });
});
