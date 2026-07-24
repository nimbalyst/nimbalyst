import { describe, expect, it, vi } from 'vitest';

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

import { createCollabExtensionHost } from '../collabExtensionHost';

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
        workspacePath: '/workspace',
        orgId: 'team-1',
        documentId: 'mockup-1',
        title: 'Wireframe',
        serverUrl: 'ws://sync',
        getJwt: async () => 'token',
        userId: 'user-1',
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
