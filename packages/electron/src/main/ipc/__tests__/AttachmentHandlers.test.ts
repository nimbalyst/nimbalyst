// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, windowStates, serviceRoots, appendAttachmentGitignore } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  windowStates: new Map<number, Record<string, any>>(),
  serviceRoots: [] as string[],
  appendAttachmentGitignore: vi.fn(async () => {}),
}));

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (name: string, fn: any) => handlers.set(name, fn),
  safeOn: (name: string, fn: any) => handlers.set(name, fn),
}));
vi.mock('../../window/WindowManager', () => ({ getWindowId: () => 1, windowStates }));
vi.mock('../../window/windowState', async () => {
  const actual = await vi.importActual<typeof import('../../window/windowState')>('../../window/windowState');
  return { ...actual, windowStates };
});
vi.mock('../../utils/store', () => ({
  getAttachmentStagingConfig: () => ({ mode: 'workspace' }),
  setAttachmentStagingConfig: vi.fn(),
  getAttachedFolders: () => [],
}));
vi.mock('../../services/attachments/attachmentStagingRoot', () => ({
  resolveWorkspaceAttachmentStagingDirectory: (workspacePath: string) => `${workspacePath}/.nimbalyst/attachments`,
}));
vi.mock('../../protocols/nimAssetProtocol', () => ({ addNimAssetRoot: vi.fn() }));
vi.mock('../../services/attachments/attachmentGitignore', () => ({
  appendAttachmentGitignore,
  getAttachmentGitignoreStatus: vi.fn(),
}));
vi.mock('../../services/AttachmentService', () => ({
  AttachmentService: class {
    constructor(private readonly root: string) {
      serviceRoots.push(root);
    }
    async saveAttachment(_buffer: Buffer, filename: string) {
      return { success: true, attachment: { filename, workspacePath: this.root } };
    }
    validateFile() {
      return { valid: true, root: this.root };
    }
  },
}));

import { registerAttachmentHandlers } from '../AttachmentHandlers';

describe('attachment handlers in a project-rail window', () => {
  beforeEach(() => {
    handlers.clear();
    serviceRoots.length = 0;
    windowStates.clear();
    // Opened on A, user switched the rail to B.
    windowStates.set(1, {
      mode: 'workspace',
      workspacePath: '/ws/a',
      additionalWorkspacePaths: ['/ws/b'],
      activeWorkspacePath: '/ws/b',
    });
    registerAttachmentHandlers();
  });

  it('saves into the active rail project, not the first one', async () => {
    const result = await handlers.get('attachment:save')!({ sender: {} }, {
      fileBuffer: [1, 2, 3],
      filename: 'shot.png',
      mimeType: 'image/png',
      sessionId: 's1',
    });
    expect(result).toMatchObject({ success: true, attachment: { workspacePath: '/ws/b' } });
    expect(serviceRoots).toEqual(['/ws/b']);
  });

  it('validates against the active rail project', async () => {
    const result = await handlers.get('attachment:validate')!({ sender: {} }, { fileSize: 1, mimeType: 'image/png' });
    expect(result).toMatchObject({ valid: true, root: '/ws/b' });
  });

  it('retry-in-workspace accepts any rail project of the calling window', async () => {
    const result = await handlers.get('attachment:retry-in-workspace')!({ sender: {} }, {
      workspacePath: '/ws/b',
      sessionId: 's1',
      attachments: [],
      addGitignore: false,
    });
    expect(result).toEqual({ success: true, attachments: [] });
    expect(appendAttachmentGitignore).toHaveBeenCalledWith('/ws/b', false);
  });

  it('retry-in-workspace still rejects a project the window does not have open', async () => {
    await expect(handlers.get('attachment:retry-in-workspace')!({ sender: {} }, {
      workspacePath: '/ws/other',
      sessionId: 's1',
      attachments: [],
      addGitignore: false,
    })).rejects.toThrow('does not match the calling window');
  });
});
