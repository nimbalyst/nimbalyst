import { describe, expect, it, vi } from 'vitest';
import type { TeamJwt } from '@nimbalyst/runtime/auth/jwtScopes';

import {
  installCollabEditorBridge,
  type NimbalystEditorBridgeApi,
} from '../bridge';
import type {
  CollabEditorFlushResult,
  CollabEditorHandle,
  CollabEditorMountOptions,
  CollabEditorPresence,
  CollabEditorState,
} from '../types';

function fakeHandle(state: CollabEditorState): CollabEditorHandle {
  return {
    getDocument: vi.fn() as CollabEditorHandle['getDocument'],
    getMarkdown: vi.fn(() => '# bridge content'),
    getState: vi.fn(() => state),
    getPresence: vi.fn(() => ({ participants: [] })),
    flush: vi.fn(async (): Promise<CollabEditorFlushResult> => ({ status: 'acknowledged' })),
    setPresenceActive: vi.fn(),
    setReadOnly: vi.fn(),
    markClean: vi.fn(),
    focus: vi.fn(),
    insertText: vi.fn(),
    formatText: vi.fn(),
    destroy: vi.fn(),
  };
}

describe('native bridge adapter', () => {
  it('maps the serializable team-room shape onto the in-page contract', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const state: CollabEditorState = {
      connection: 'connecting',
      edit: 'clean',
      readOnly: false,
      hostReadOnly: false,
      serverAccess: 'unknown',
      termination: null,
    };
    const handle = fakeHandle(state);
    const presence: CollabEditorPresence = {
      participants: [{
        memberId: 'member-2' as CollabEditorPresence['participants'][number]['memberId'],
        displayName: 'Remote Member',
        cursorColor: '#16A34A',
        hasSelection: true,
      }],
    };
    const mountEditor = vi.fn((options: CollabEditorMountOptions) => {
      options.onStateChange?.(state);
      options.onPresenceChange?.(presence);
      options.onReady?.(handle);
      return handle;
    });
    const element = document.createElement('div');
    const remove = installCollabEditorBridge({
      element,
      target: window,
      postMessage: (message) => messages.push(message),
      mountEditor,
    });
    const api = (window as typeof window & { nimbalystEditor: NimbalystEditorBridgeApi })
      .nimbalystEditor;

    api.mount({
      source: {
        kind: 'team-room',
        serverUrl: 'wss://sync.example.test',
        room: { orgId: 'org-1', projectId: 'project-1', documentId: 'doc-1' },
        auth: { scope: 'team', memberId: 'member-1', jwt: 'team-jwt-1' },
      },
      user: { name: 'Bridge User' },
    });

    expect(mountEditor).toHaveBeenCalledOnce();
    const mountedOptions = mountEditor.mock.calls[0][0];
    expect(mountedOptions.source.kind).toBe('team-room');
    if (mountedOptions.source.kind !== 'team-room') {
      throw new Error('team-room options not captured');
    }
    expect(mountedOptions.source.auth.scope).toBe('team');
    await expect(mountedOptions.source.auth.getTeamJwt()).resolves.toBe('team-jwt-1');
    expect(messages.map((message) => message.type)).toEqual([
      'stateChanged',
      'presenceChanged',
      'editorReady',
    ]);
    expect(messages).toContainEqual({ type: 'presenceChanged', presence });

    const refreshed = mountedOptions.source.auth.getTeamJwt({ forceRefresh: true });
    const authRequest = messages.find((message) => message.type === 'authRequested');
    expect(authRequest).toMatchObject({ scope: 'team', forceRefresh: true });
    api.provideTeamJwt({
      requestId: String(authRequest?.requestId),
      scope: 'team',
      jwt: 'team-jwt-2',
    });
    await expect(refreshed).resolves.toBe('team-jwt-2' as TeamJwt);

    api.setReadOnly(true);
    expect(handle.setReadOnly).toHaveBeenCalledWith(true);
    api.setPresenceActive(false);
    expect(handle.setPresenceActive).toHaveBeenCalledWith(false);
    expect(api.getContent()).toBe('# bridge content');

    await expect(api.flush({ requestId: 'flush-1', timeoutMs: 250 })).resolves.toEqual({
      status: 'acknowledged',
    });
    expect(handle.flush).toHaveBeenCalledWith({ timeoutMs: 250 });
    expect(messages).toContainEqual({
      type: 'flushCompleted',
      requestId: 'flush-1',
      result: { status: 'acknowledged' },
    });

    const rejection = {
      code: 'document_read_only' as const,
      message: 'Role changed',
      clientUpdateId: 'update-1',
    };
    mountedOptions.onWriteRejected?.(rejection);
    expect(messages).toContainEqual({ type: 'writeRejected', rejection });

    const termination = {
      reason: 'removed-from-org' as const,
      closeCode: 4002 as const,
      message: 'Removed from team',
    };
    mountedOptions.onTermination?.(termination);
    expect(messages).toContainEqual({ type: 'terminated', termination });

    remove();
    expect(handle.destroy).toHaveBeenCalledOnce();
    expect('nimbalystEditor' in window).toBe(false);
  });
});
