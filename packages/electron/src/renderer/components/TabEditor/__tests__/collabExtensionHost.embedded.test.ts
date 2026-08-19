// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

const mocks = vi.hoisted(() => ({
  storeSet: vi.fn(),
  setEditorContext: vi.fn(),
  setEditorContextItems: vi.fn(),
}));

vi.mock('@nimbalyst/runtime/store', () => ({
  store: { set: mocks.storeSet },
  editorDirtyAtom: vi.fn(),
  makeEditorKey: vi.fn(() => 'editor-key'),
}));
vi.mock('../../../stores/editorContextStore', () => ({
  setEditorContext: mocks.setEditorContext,
  setEditorContextItems: mocks.setEditorContextItems,
}));
vi.mock('../../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showWarning: vi.fn() },
}));

import {
  createCollabExtensionHost,
  createCollaborationContext,
  flushCollaborativeContent,
} from '../collabExtensionHost';

describe('createCollabExtensionHost embedded mode', () => {
  it('enforces read-only embedded semantics without polluting tab state', () => {
    const onDirtyChange = vi.fn();
    const collaboration = { yDoc: {} } as never;
    const host = createCollabExtensionHost({
      filePath: 'collab://org:team-1:doc:mockup-1',
      fileName: 'Wireframe',
      isActive: true,
      workspaceId: '/workspace',
      activeConfig: {
        scope: {
          scopeKey: '/workspace',
          orgId: 'team-1',
          indexConfig: { serverUrl: 'ws://sync', teamMemberId: asTeamMemberId('user-1') },
        },
        orgId: 'team-1',
        documentId: 'mockup-1',
        title: 'Wireframe',
        serverUrl: 'ws://sync',
        getJwt: async () => asTeamJwt('token'),
        teamMemberId: asTeamMemberId('user-1'),
        accountId: 'account-1',
      },
      collaboration,
      onDirtyChange,
      embedded: true,
      readOnly: true,
    });

    expect(host.embedded).toBe(true);
    expect(host.readOnly).toBe(true);
    expect(host.collaboration).toBe(collaboration);

    host.setDirty(true);
    host.setEditorContext?.({ kind: 'selection', content: 'ignored' } as never);
    host.setEditorContextItems?.([]);
    expect(onDirtyChange).not.toHaveBeenCalled();
    expect(mocks.storeSet).not.toHaveBeenCalled();
    expect(mocks.setEditorContext).not.toHaveBeenCalled();
    expect(mocks.setEditorContextItems).not.toHaveBeenCalled();
  });
});

describe('flushCollaborativeContent', () => {
  function makeContext(flushWithAck: () => Promise<boolean>) {
    return createCollaborationContext({
      syncProvider: {
        getYDoc: () => ({}),
        getStatus: () => 'connected',
        flushWithAck,
        hasUndecodedContent: () => false,
        flushLocalState: async () => {},
      } as never,
      awareness: {} as never,
      activeConfig: { teamMemberId: 'user-1', userName: 'User One' } as never,
    });
  }

  it('drains pending binding content before waiting on the server ack', async () => {
    // The order is the whole point: a binding's debounced edit has to reach the
    // Y.Doc before the flush that waits for the server to persist it, or the
    // AI tool that triggered this reports success on a document that does not
    // contain the edit yet.
    const calls: string[] = [];
    const context = makeContext(async () => {
      calls.push('ack');
      return true;
    });
    context.registerContentFlush?.(() => {
      calls.push('binding');
    });

    await expect(flushCollaborativeContent(context)).resolves.toBe(true);
    expect(calls).toEqual(['binding', 'ack']);
  });

  it('still awaits the server ack when no binding registered a flush', async () => {
    const flushWithAck = vi.fn(async () => false);
    await expect(flushCollaborativeContent(makeContext(flushWithAck))).resolves.toBe(false);
    expect(flushWithAck).toHaveBeenCalledTimes(1);
  });

  it('drains the rest and acks after one binding fails, but reports the failure', async () => {
    const calls: string[] = [];
    const context = makeContext(async () => {
      calls.push('ack');
      return true;
    });
    context.registerContentFlush?.(() => {
      throw new Error('binding blew up');
    });
    context.registerContentFlush?.(() => {
      calls.push('second');
    });

    // A binding that threw never pushed its newest edit, so the write is not
    // complete however cleanly the server acked what it did receive.
    await expect(flushCollaborativeContent(context)).resolves.toBe(false);
    expect(calls).toEqual(['second', 'ack']);
  });

  it('stops draining a flush once its binding unregisters', async () => {
    const context = makeContext(async () => true);
    const flush = vi.fn();
    const unregister = context.registerContentFlush?.(flush);
    unregister?.();

    await flushCollaborativeContent(context);
    expect(flush).not.toHaveBeenCalled();
  });
});
