// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  resolveShareability: vi.fn(),
  resolveMetadata: vi.fn(),
  openDialog: vi.fn(),
  activeTeamOrgIdAtom: Symbol('activeTeamOrgId'),
  resolveDesktopCollabScope: vi.fn(async () => ({
    scope: {
      scopeKey: '/workspace',
      orgId: 'team-1',
      indexConfig: { serverUrl: 'ws://sync', userId: 'user-1' },
    },
    retryable: false,
  })),
  trashSharedDocument: vi.fn(),
  createCollaborativeDocument: vi.fn(),
  buildSharedDocumentDeepLink: vi.fn((documentId: string, orgId: string) =>
    `nimbalyst://doc/${encodeURIComponent(documentId)}?orgId=${encodeURIComponent(orgId)}`),
  copyToClipboard: vi.fn(),
  showError: vi.fn(),
  showInfo: vi.fn(),
  showWarning: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
  copyToClipboard: mocks.copyToClipboard,
  getEmbeddableExtensions: () => ['.mockup.html'],
  getShowInFileBrowserLabel: () => 'Show in Explorer',
  parseEmbedAttrs: () => ({}),
  serializeEmbedAttrs: (attrs: Record<string, string>) =>
    Object.entries(attrs).map(([key, value]) => `${key}=${value}`).join(' '),
}));
vi.mock('@nimbalyst/runtime/store', () => ({
  store: {
    get: vi.fn((atom: unknown) => (atom === mocks.activeTeamOrgIdAtom ? 'team-1' : '/workspace')),
  },
}));
vi.mock('jotai', async (importOriginal) => ({
  ...await importOriginal<typeof import('jotai')>(),
  useAtomValue: vi.fn(() => true),
}));
vi.mock('../../hooks/useFileActions', () => ({
  useFileActions: () => ({
    openInDefaultApp: vi.fn(),
    hasExternalEditor: false,
    revealInFinder: vi.fn(),
    copyFilePath: vi.fn(),
    isShareable: false,
  }),
}));
vi.mock('../../store/atoms/collabDocuments', () => ({
  workspaceHasTeamAtom: Symbol('workspaceHasTeam'),
  activeTeamOrgIdAtom: mocks.activeTeamOrgIdAtom,
  resolveDesktopCollabScope: mocks.resolveDesktopCollabScope,
  buildSharedDocumentDeepLink: mocks.buildSharedDocumentDeepLink,
  trashSharedDocument: mocks.trashSharedDocument,
}));
vi.mock('../../store/atoms/openProjects', () => ({ activeWorkspacePathAtom: Symbol('activeWorkspace') }));
vi.mock('../../dialogs', () => ({
  dialogRef: { current: { open: mocks.openDialog } },
  DIALOG_IDS: { SHARE_TO_TEAM: 'share-to-team' },
}));
vi.mock('../../services/CollaborativeDocumentTypeCatalog', () => ({
  getCollaborativeDocumentTypeCatalog: () => ({
    subscribe: () => () => {},
    getSnapshot: () => 0,
    resolveShareability: mocks.resolveShareability,
    resolveMetadata: mocks.resolveMetadata,
    editorIdForDescriptor: vi.fn(),
  }),
}));
vi.mock('../../services/collaborativeDocumentCreationOrchestrator', () => ({
  CollaborativeDocumentCreationError: class extends Error {},
  createCollaborativeDocument: mocks.createCollaborativeDocument,
}));
vi.mock('../../services/ErrorNotificationService', () => ({
  errorNotificationService: {
    showError: mocks.showError,
    showInfo: mocks.showInfo,
    showWarning: mocks.showWarning,
  },
}));

import { CommonFileActions, readShareToTeamSourceContent } from '../CommonFileActions';

const spreadsheetDescriptor = {
  documentType: 'csv',
  displayName: 'CSV Spreadsheet',
  fileExtensions: ['.csv', '.tsv'],
  defaultExtension: '.csv',
  icon: 'table',
  editor: { kind: 'extension', extensionId: 'com.nimbalyst.csv' },
  content: { strategy: 'structured-yjs', codecId: 'csv' },
  capabilities: {
    localCreate: true,
    shareToTeam: true,
    sharedCreate: true,
    history: true,
    export: true,
    embed: false,
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderActions(fileName: string) {
  return render(
    <CommonFileActions
      filePath={`/workspace/${fileName}`}
      fileName={fileName}
      onClose={() => {}}
      menuItemClass="menu-item"
      separatorClass="separator"
      useButtons
    />,
  );
}

describe('CommonFileActions Share to Team catalog eligibility', () => {
  it('uses the platform-aware system file browser label', () => {
    mocks.resolveShareability.mockReturnValue({ state: 'unsupported', reason: 'Unsupported' });
    renderActions('index.ts');

    screen.getByRole('button', { name: 'Show in Explorer' });
    expect(screen.queryByRole('button', { name: 'Show in Finder' })).toBeNull();
  });

  it('inspects markdown embeds before opening the share dialog', async () => {
    const markdownDescriptor = {
      ...spreadsheetDescriptor,
      documentType: 'markdown',
      displayName: 'Markdown',
      fileExtensions: ['.md'],
      defaultExtension: '.md',
      editor: { kind: 'lexical' },
      content: { strategy: 'lexical', codecId: 'markdown' },
    };
    const mockupDescriptor = {
      ...spreadsheetDescriptor,
      documentType: 'mockup',
      displayName: 'Mockup',
      fileExtensions: ['.mockup.html'],
      defaultExtension: '.mockup.html',
      icon: 'web',
      editor: { kind: 'extension', extensionId: 'mockup' },
    };
    mocks.resolveShareability.mockImplementation((name: string) => ({
      state: 'ready',
      descriptor: name.endsWith('.mockup.html')
        ? mockupDescriptor
        : markdownDescriptor,
    }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        readFileContent: vi.fn(async (path: string) => (
          path.endsWith('notes.md')
            ? {
                success: true,
                content: '[Wireframe](./wireframe.mockup.html)',
                isBinary: false,
              }
            : { success: true, content: 'PGh0bWw+', isBinary: true }
        )),
        invoke: vi.fn(async (channel: string) => (channel === 'file:exists' ? true : undefined)),
        documentSync: {
          findLocalOriginLink: vi.fn(async () => ({
            success: true,
            binding: {
              documentId: 'mockup-1',
              orgId: 'team-1',
            },
          })),
        },
      },
    });

    renderActions('notes.md');
    fireEvent.click(screen.getByRole('button', { name: 'Share to Team' }));

    await vi.waitFor(() => expect(mocks.openDialog).toHaveBeenCalledWith(
      'share-to-team',
      expect.objectContaining({
        embeddedDocuments: [
          expect.objectContaining({
            absolutePath: '/workspace/wireframe.mockup.html',
            alreadyShared: {
              documentId: 'mockup-1',
              orgId: 'team-1',
            },
          }),
        ],
      }),
    ));
  });

  it('shows Share to Team for a ready first-wave non-markdown type', () => {
    mocks.resolveShareability.mockReturnValue({ state: 'ready', descriptor: spreadsheetDescriptor });
    renderActions('people.tsv');

    fireEvent.click(screen.getByRole('button', { name: 'Share to Team' }));
    expect(mocks.openDialog).toHaveBeenCalledWith('share-to-team', expect.objectContaining({
      fileName: 'people.tsv',
      descriptor: spreadsheetDescriptor,
    }));
  });

  it('adds a Copy Link action to the successful share toast', async () => {
    mocks.resolveShareability.mockReturnValue({ state: 'ready', descriptor: spreadsheetDescriptor });
    mocks.resolveMetadata.mockReturnValue({ state: 'ready', descriptor: spreadsheetDescriptor });
    mocks.createCollaborativeDocument.mockResolvedValue({
      documentId: 'document/one',
      title: 'people.csv',
      documentType: 'csv',
      parentFolderId: null,
    });
    mocks.copyToClipboard.mockResolvedValue(undefined);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        readFileContent: vi.fn(async () => ({
          success: true,
          content: 'name\nAda',
          isBinary: false,
        })),
        invoke: vi.fn(async () => undefined),
      },
    });

    renderActions('people.csv');
    fireEvent.click(screen.getByRole('button', { name: 'Share to Team' }));
    const dialogData = mocks.openDialog.mock.calls[0]?.[1];
    await dialogData.onConfirm({
      folderId: null,
      folderPath: '',
      sharedName: 'people.csv',
      selectedEmbeddedDocumentPaths: [],
    });

    await vi.waitFor(() => {
      expect(mocks.showInfo).toHaveBeenCalledWith(
        'Shared to team',
        '"people.csv" is now a collaborative document.',
        expect.objectContaining({
          action: expect.objectContaining({ label: 'Copy Link' }),
        }),
      );
    });

    const action = mocks.showInfo.mock.calls[0]?.[2]?.action;
    await action.onClick();

    expect(mocks.buildSharedDocumentDeepLink).toHaveBeenCalledWith('document/one', 'team-1');
    expect(mocks.copyToClipboard).toHaveBeenCalledWith(
      'nimbalyst://doc/document%2Fone?orgId=team-1',
    );
  });

  it('keeps Monaco files visible but disabled with the catalog reason', () => {
    const reason = 'The built-in Monaco editor does not yet provide a collaborative binding for ".ts".';
    mocks.resolveShareability.mockReturnValue({ state: 'unsupported', reason });
    renderActions('index.ts');

    const action = screen.getByRole('button', { name: /Share to Team/ });
    expect(action.getAttribute('aria-disabled')).toBe('true');
    expect(action.textContent).toContain(reason);
    fireEvent.click(action);
    expect(mocks.openDialog).not.toHaveBeenCalled();
  });

  it('does not offer Share to Team for an already-shared collaborative document', () => {
    mocks.resolveShareability.mockReturnValue({ state: 'ready', descriptor: spreadsheetDescriptor });
    render(
      <CommonFileActions
        filePath="collab://org:team-a:doc:document-a"
        fileName="people.csv"
        onClose={() => {}}
        menuItemClass="menu-item"
        separatorClass="separator"
        useButtons
      />,
    );

    expect(screen.queryByRole('button', { name: 'Share to Team' })).toBeNull();
  });

  it('omits Copy Path for collaborative documents while keeping it for local files', () => {
    mocks.resolveShareability.mockReturnValue({ state: 'ready', descriptor: spreadsheetDescriptor });
    const { rerender } = render(
      <CommonFileActions
        filePath="collab://org:team-a:doc:document-a"
        fileName="people.csv"
        onClose={() => {}}
        menuItemClass="menu-item"
        separatorClass="separator"
        useButtons
      />,
    );

    expect(screen.queryByRole('button', { name: 'Copy Path' })).toBeNull();

    rerender(
      <CommonFileActions
        filePath="/workspace/people.csv"
        fileName="people.csv"
        onClose={() => {}}
        menuItemClass="menu-item"
        separatorClass="separator"
        useButtons
      />,
    );

    screen.getByRole('button', { name: 'Copy Path' });
  });

  it('reads text descriptors as UTF-8 strings and opaque descriptors as bytes', async () => {
    const readFileContent = vi.fn()
      .mockResolvedValueOnce({ success: true, content: 'a,b\n1,2', isBinary: false })
      .mockResolvedValueOnce({ success: true, content: 'AQID', isBinary: true });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { readFileContent },
    });

    await expect(readShareToTeamSourceContent('/workspace/data.csv', spreadsheetDescriptor as any))
      .resolves.toBe('a,b\n1,2');
    await expect(readShareToTeamSourceContent('/workspace/design.imgproj', {
      ...spreadsheetDescriptor,
      content: { strategy: 'opaque-versioned', codecId: 'imgproj' },
    } as any)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(readFileContent).toHaveBeenNthCalledWith(1, '/workspace/data.csv', undefined);
    expect(readFileContent).toHaveBeenNthCalledWith(2, '/workspace/design.imgproj', { binary: true });
  });
});
