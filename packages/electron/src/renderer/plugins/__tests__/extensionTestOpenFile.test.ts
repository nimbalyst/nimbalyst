// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom, multiProjectModeAtom, openProjectsAtom } from '../../store/atoms/openProjects';
import { selectFileForExtensionTest } from '../extensionTestOpenFile';

const PROJECT_A = '/Users/dev/project-a';
const PROJECT_B = '/Users/dev/project-b';

afterEach(() => {
  delete (globalThis as any).window;
});

describe('selectFileForExtensionTest', () => {
  // Main routes extension_test_open_file to the window whose rail holds the
  // project, which may be showing another rail project. App re-binds the
  // file-select handler to the visible project only after it renders.
  it('opens the file in the requested rail project, not the active one', async () => {
    store.set(multiProjectModeAtom, true);
    store.set(openProjectsAtom, [
      { path: PROJECT_A, name: 'project-a', openedAt: 0 },
      { path: PROJECT_B, name: 'project-b', openedAt: 0 },
    ]);
    store.set(activeWorkspacePathAtom, PROJECT_A);
    const opened: Array<{ workspacePath: string; filePath: string }> = [];
    const bind = (workspacePath: string) => {
      (globalThis as any).window.__workspacePath = workspacePath;
      (globalThis as any).window.__handleWorkspaceFileSelect = async (filePath: string) => {
        opened.push({ workspacePath, filePath });
      };
    };
    (globalThis as any).window = { electronAPI: { invoke: vi.fn(async () => ({ success: true })) } };
    bind(PROJECT_A);
    const stop = store.sub(activeWorkspacePathAtom, () => {
      const next = store.get(activeWorkspacePathAtom)!;
      setTimeout(() => bind(next), 20);
    });

    try {
      await selectFileForExtensionTest(`${PROJECT_B}/doc.mindmap`, PROJECT_B, 2000);
    } finally {
      stop();
    }

    expect(store.get(activeWorkspacePathAtom)).toBe(PROJECT_B);
    expect(opened).toEqual([{ workspacePath: PROJECT_B, filePath: `${PROJECT_B}/doc.mindmap` }]);
  });
});
