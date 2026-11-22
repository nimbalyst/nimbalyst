import { act, renderHook, waitFor } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import type { EditorHost } from '../types/editor.js';
import { useCollaborativeEditor } from '../useCollaborativeEditor.js';

describe('useCollaborativeEditor offline replica binding', () => {
  it('binds an already-hydrated Y.Doc without waiting for the transport', async () => {
    const yDoc = new Y.Doc();
    yDoc.getMap('nodes').set('node_root', 'persisted');
    const awareness = new Awareness(yDoc);
    const loadInitialContent = vi.fn(async () => 'must not seed offline');
    const bind = vi.fn(() => ({ destroy: vi.fn() }));
    const host = {
      collaboration: {
        yDoc,
        awareness,
        user: { id: 'offline-user', name: 'Offline User', color: '#123456' },
        getStatus: () => 'disconnected',
        onStatusChange: () => () => {},
        loadInitialContent,
      },
    } as unknown as EditorHost;

    const { unmount } = renderHook(() => useCollaborativeEditor(host, {
      isEmpty: doc => doc.getMap('nodes').size === 0,
      initializeFromContent: vi.fn(),
      createBinding: bind,
    }));

    await waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
    expect(loadInitialContent).not.toHaveBeenCalled();

    unmount();
    awareness.destroy();
    yDoc.destroy();
  });

  it('does not start a second binding while the first async bind is unresolved', async () => {
    const yDoc = new Y.Doc();
    yDoc.getMap('nodes').set('node_root', 'persisted');
    const awareness = new Awareness(yDoc);
    let notifyStatusChange: () => void = () => {};
    let finishBind: () => void = () => {};
    const bindReady = new Promise<void>((resolve) => {
      finishBind = resolve;
    });
    const destroy = vi.fn();
    const bind = vi.fn(async () => {
      await bindReady;
      return { destroy };
    });
    const host = {
      collaboration: {
        yDoc,
        awareness,
        user: { id: 'offline-user', name: 'Offline User', color: '#123456' },
        getStatus: () => 'disconnected',
        onStatusChange: (callback: () => void) => {
          notifyStatusChange = callback;
          return () => {};
        },
        loadInitialContent: vi.fn(async () => 'must not seed offline'),
      },
    } as unknown as EditorHost;

    const { result, unmount } = renderHook(() => useCollaborativeEditor(host, {
      isEmpty: doc => doc.getMap('nodes').size === 0,
      initializeFromContent: vi.fn(),
      createBinding: bind,
    }));

    await waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
    act(() => notifyStatusChange());
    expect(bind).toHaveBeenCalledTimes(1);

    finishBind();
    await waitFor(() => expect(result.current.binding).not.toBeNull());
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
    awareness.destroy();
    yDoc.destroy();
  });
  it('never seeds an empty room from a read-only host (commenter), and still binds', async () => {
    const yDoc = new Y.Doc();
    const awareness = new Awareness(yDoc);
    const loadInitialContent = vi.fn(async () => 'seed content');
    const seed = vi.fn();
    const bind = vi.fn(() => ({ destroy: vi.fn() }));
    const host = {
      readOnly: true,
      collaboration: {
        yDoc,
        awareness,
        user: { id: 'commenter', name: 'Commenter', color: '#123456' },
        getStatus: () => 'connected',
        onStatusChange: () => () => {},
        loadInitialContent,
        flushWithAck: vi.fn(async () => true),
      },
    } as unknown as EditorHost;

    const { unmount } = renderHook(() => useCollaborativeEditor(host, {
      isEmpty: doc => doc.getMap('nodes').size === 0,
      initializeFromContent: seed,
      createBinding: bind,
    }));

    await waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
    expect(loadInitialContent).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
    expect(yDoc.getMap('nodes').size).toBe(0);

    unmount();
    awareness.destroy();
    yDoc.destroy();
  });
});
