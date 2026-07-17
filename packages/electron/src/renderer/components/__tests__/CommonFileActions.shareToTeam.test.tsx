// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  resolveShareability: vi.fn(),
  openDialog: vi.fn(),
}));

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));
vi.mock('@nimbalyst/runtime/store', () => ({ store: { get: vi.fn(() => '/workspace') } }));
vi.mock('jotai', () => ({ useAtomValue: vi.fn(() => true) }));
vi.mock('../../hooks/useFileActions', () => ({
  useFileActions: () => ({
    openInDefaultApp: vi.fn(),
    hasExternalEditor: false,
    revealInFinder: vi.fn(),
    copyFilePath: vi.fn(),
    isShareable: false,
  }),
}));
vi.mock('../../store/atoms/collabDocuments', () => ({ workspaceHasTeamAtom: Symbol('workspaceHasTeam') }));
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
    resolveMetadata: vi.fn(),
    editorIdForDescriptor: vi.fn(),
  }),
}));
vi.mock('../../services/collaborativeDocumentCreationOrchestrator', () => ({
  CollaborativeDocumentCreationError: class extends Error {},
  createCollaborativeDocument: vi.fn(),
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
  it('shows Share to Team for a ready first-wave non-markdown type', () => {
    mocks.resolveShareability.mockReturnValue({ state: 'ready', descriptor: spreadsheetDescriptor });
    renderActions('people.tsv');

    fireEvent.click(screen.getByRole('button', { name: 'Share to Team' }));
    expect(mocks.openDialog).toHaveBeenCalledWith('share-to-team', expect.objectContaining({
      fileName: 'people.tsv',
      descriptor: spreadsheetDescriptor,
    }));
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
