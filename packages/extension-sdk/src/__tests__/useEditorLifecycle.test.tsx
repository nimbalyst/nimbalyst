import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { EditorHost } from '../types/editor.js';
import { useEditorLifecycle } from '../useEditorLifecycle.js';

function createHost(loadContent: () => Promise<string>): {
  host: EditorHost;
  notifyFileChanged: (content: string) => void;
} {
  let fileChanged: ((content: string) => void) | undefined;

  const host = {
    filePath: '/workspace/plans/example.mockup.html',
    fileName: 'example.mockup.html',
    isActive: true,
    theme: 'dark',
    loadContent,
    loadBinaryContent: vi.fn(),
    saveContent: vi.fn(),
    setDirty: vi.fn(),
    onSaveRequested: () => () => {},
    onFileChanged: (callback: (content: string) => void) => {
      fileChanged = callback;
      return () => {
        fileChanged = undefined;
      };
    },
    onThemeChanged: () => () => {},
    registerMenuItems: vi.fn(),
    registerEditorAPI: vi.fn(),
    setEditorContext: vi.fn(),
    setEditorContextItems: vi.fn(),
    storage: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      getGlobal: vi.fn(),
      setGlobal: vi.fn(),
      deleteGlobal: vi.fn(),
      getSecret: vi.fn(),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
    },
  } as unknown as EditorHost;

  return {
    host,
    notifyFileChanged(content: string) {
      fileChanged?.(content);
    },
  };
}

describe('useEditorLifecycle', () => {
  it('recovers when a missing file appears after the initial load fails', async () => {
    const applyContent = vi.fn();
    const { host, notifyFileChanged } = createHost(() =>
      Promise.reject(new Error('File not found')),
    );

    const { result } = renderHook(() =>
      useEditorLifecycle(host, { applyContent }),
    );

    await waitFor(() => {
      expect(result.current.error?.message).toBe('File not found');
    });

    act(() => {
      notifyFileChanged('<html>created later</html>');
    });

    expect(applyContent).toHaveBeenCalledWith('<html>created later</html>');
    expect(result.current.error).toBeNull();
  });
});
