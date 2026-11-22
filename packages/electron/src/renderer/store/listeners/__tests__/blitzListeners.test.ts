// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom, openProjectsAtom } from '../../atoms/openProjects';
import { initBlitzListeners } from '../blitzListeners';

const PROJECT_A = '/Users/dev/project-a';
const PROJECT_B = '/Users/dev/project-b';

function installWindow() {
  const handlers = new Map<string, (data: unknown) => void>();
  const invoke = vi.fn(async () => ({ success: true }));
  (globalThis as any).window = {
    electronAPI: {
      invoke,
      on: vi.fn((channel: string, handler: (data: unknown) => void) => {
        handlers.set(channel, handler);
        return () => {};
      }),
    },
  };
  return { handlers, invoke };
}

afterEach(() => {
  delete (globalThis as any).window;
});

describe('blitz:analysis-created', () => {
  // The blitz children finish while the user is looking at another rail
  // project. The analysis must start anyway, not when someone opens it.
  it('starts the analysis for a rail project that is not the active one', () => {
    store.set(openProjectsAtom, [
      { path: PROJECT_A, name: 'project-a', openedAt: 0 },
      { path: PROJECT_B, name: 'project-b', openedAt: 0 },
    ]);
    store.set(activeWorkspacePathAtom, PROJECT_A);
    const { handlers, invoke } = installWindow();
    const stop = initBlitzListeners();
    try {
      handlers.get('blitz:analysis-created')!({ blitzId: 'blitz-1', analysisSessionId: 'analysis-1', workspacePath: PROJECT_B });
      handlers.get('blitz:analysis-created')!({ blitzId: 'blitz-2', analysisSessionId: 'analysis-2', workspacePath: '/Users/dev/elsewhere' });
    } finally {
      stop();
    }

    expect(invoke).toHaveBeenCalledWith('ai:triggerQueueProcessing', 'analysis-1', PROJECT_B);
    // Another window holds that project; it starts it there.
    expect(invoke).not.toHaveBeenCalledWith('ai:triggerQueueProcessing', 'analysis-2', expect.anything());
  });
});
