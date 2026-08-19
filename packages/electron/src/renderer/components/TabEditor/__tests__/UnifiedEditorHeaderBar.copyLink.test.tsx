// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnifiedEditorHeaderBar } from '../UnifiedEditorHeaderBar';

const { buildSharedDocumentDeepLink, copyToClipboard, localLinkState } = vi.hoisted(() => ({
  buildSharedDocumentDeepLink: vi.fn((documentId: string, orgId: string) =>
    `nimbalyst://doc/${encodeURIComponent(documentId)}?orgId=${encodeURIComponent(orgId)}`),
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  localLinkState: {
    binding: null as Record<string, unknown> | null,
    busyAction: null as string | null,
    refresh: vi.fn().mockResolvedValue(undefined),
    pullFromSharedDoc: vi.fn().mockResolvedValue(true),
    reuploadToSharedDoc: vi.fn().mockResolvedValue(true),
  },
}));

vi.mock('@nimbalyst/runtime', () => ({
  $convertToEnhancedMarkdownString: vi.fn(),
  $convertFromEnhancedMarkdownString: vi.fn(),
  getEditorTransformers: vi.fn(() => []),
  wrapWithPrintStyles: vi.fn(),
  applyTrackerTypeToMarkdown: vi.fn(),
  getDefaultFrontmatterForType: vi.fn(),
  getModelDefaults: vi.fn(() => ({})),
  getCurrentTrackerTypeFromMarkdown: vi.fn(() => null),
  removeTrackerTypeFromMarkdown: vi.fn(),
  copyToClipboard,
  ProviderIcon: () => null,
}));

vi.mock('../../../store', async () => {
  const { atom } = await import('jotai');
  return { historyDialogFileAtom: atom<string | null>(null) };
});

vi.mock('../../../store/atoms/collabDocuments', async () => {
  const { atom } = await import('jotai');
  return {
    sharedDocumentsAtom: atom([]),
    pendingCollabDocumentAtom: atom(null),
    // Deliberately differs from the explicit link target below. Copy Link must
    // use the canonical document target, not ambient active-scope identity.
    activeCollabScopeAtom: atom({
      scopeKey: '/workspace',
      orgId: 'different-active-org',
      indexConfig: { serverUrl: 'wss://test.invalid', teamMemberId: 'user-1' },
    }),
    activeTeamOrgIdAtom: atom(null),
    buildSharedDocumentDeepLink,
  };
});

vi.mock('../../../store/atoms/windowMode', async () => {
  const { atom } = await import('jotai');
  return { setWindowModeAtom: atom(null, () => undefined) };
});

vi.mock('../../../services/RendererDocumentService', () => ({
  getDocumentService: vi.fn(),
}));

vi.mock('../../CommonFileActions', () => ({ CommonFileActions: () => null }));
vi.mock('../../common/FilePathBreadcrumb', () => ({ FilePathBreadcrumb: () => null }));
vi.mock('../../../dialogs', () => ({
  dialogRef: { current: null },
  DIALOG_IDS: {},
}));
vi.mock('../../CollabMode/collabTree', () => ({
  getCollabNodeName: vi.fn(),
  getCollabParentPath: vi.fn(),
  normalizeCollabPath: vi.fn(),
}));

vi.mock('../../../hooks/useFloatingMenu', async () => {
  const ReactModule = await import('react');
  return {
    FloatingPortal: ({ children }: { children: React.ReactNode }) => children,
    useFloatingMenu: () => {
      const [isOpen, setIsOpen] = ReactModule.useState(false);
      return {
        isOpen,
        setIsOpen,
        refs: { setReference: () => undefined, setFloating: () => undefined },
        floatingStyles: {},
        getReferenceProps: () => ({}),
        getFloatingProps: () => ({}),
      };
    },
  };
});

vi.mock('../../../hooks/useCollabLocalOrigin', () => ({
  useLocalFileSharedDocLink: () => ({
    binding: localLinkState.binding,
    busyAction: localLinkState.busyAction,
    loading: false,
    refresh: localLinkState.refresh,
    pullFromSharedDoc: localLinkState.pullFromSharedDoc,
    reuploadToSharedDoc: localLinkState.reuploadToSharedDoc,
  }),
}));

afterEach(() => {
  cleanup();
  buildSharedDocumentDeepLink.mockClear();
  copyToClipboard.mockClear();
  localLinkState.binding = null;
  localLinkState.busyAction = null;
  localLinkState.refresh.mockClear();
  localLinkState.pullFromSharedDoc.mockClear();
  localLinkState.reuploadToSharedDoc.mockClear();
});

const lexicalEditor = {
  getEditorState: () => ({ read: vi.fn() }),
  registerUpdateListener: () => vi.fn(),
  getElementByKey: () => null,
  update: vi.fn(),
};

describe('UnifiedEditorHeaderBar shared document link', () => {
  it('shows and copies the canonical deep link for an open collaborative document', async () => {
    render(
      <UnifiedEditorHeaderBar
        filePath="collab://org:team%20one:doc:doc/one"
        fileName="Shared doc"
        workspaceId="/workspace"
        isMarkdown
        lexicalEditor={lexicalEditor}
        showShareLinkButton={false}
        showSharedDocButton={false}
        showCommonFileActions={false}
        sharedDocumentLinkTarget={{ documentId: 'doc/one', orgId: 'team one' }}
      />,
    );

    fireEvent.click(screen.getByTitle('More actions'));

    const copyLink = screen.getByRole('button', { name: 'Copy link' });
    const copyMarkdown = screen.getByRole('button', { name: 'Copy as Markdown' });
    expect(copyLink.nextElementSibling).toBe(copyMarkdown);
    expect(buildSharedDocumentDeepLink).toHaveBeenCalledWith('doc/one', 'team one');

    fireEvent.click(copyLink);

    await waitFor(() => {
      expect(copyToClipboard).toHaveBeenCalledWith(
        'nimbalyst://doc/doc%2Fone?orgId=team%20one',
      );
    });
  });

  it('hides Copy link when no shared-document link is available', () => {
    render(
      <UnifiedEditorHeaderBar
        filePath="/workspace/local.md"
        fileName="local.md"
        workspaceId="/workspace"
        isMarkdown
        lexicalEditor={lexicalEditor}
        showShareLinkButton={false}
        showSharedDocButton={false}
        showCommonFileActions={false}
      />,
    );

    fireEvent.click(screen.getByTitle('More actions'));

    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    screen.getByRole('button', { name: 'Copy as Markdown' });
  });

  it('shows Pull from Shared Doc above re-upload for a linked local file', () => {
    localLinkState.binding = {
      documentId: 'doc-1',
      sourceBasename: 'local.md',
      documentType: 'markdown',
      createdAt: '2026-08-07T12:00:00.000Z',
    };

    render(
      <UnifiedEditorHeaderBar
        filePath="/workspace/local.md"
        fileName="local.md"
        workspaceId="/workspace"
        isMarkdown
        lexicalEditor={lexicalEditor}
        showShareLinkButton={false}
        showCommonFileActions={false}
      />,
    );

    fireEvent.click(screen.getByTitle('Linked to team shared document'));

    const pull = screen.getByRole('button', { name: 'Pull from Shared Doc' });
    const reupload = screen.getByRole('button', { name: 'Re-upload to Shared Doc' });
    expect(pull.nextElementSibling).toBe(reupload);
    expect(pull.hasAttribute('disabled')).toBe(false);
  });

  it('disables Pull from Shared Doc while another local-origin action is busy', () => {
    localLinkState.binding = {
      documentId: 'doc-1',
      sourceBasename: 'local.md',
      documentType: 'markdown',
      createdAt: '2026-08-07T12:00:00.000Z',
    };
    localLinkState.busyAction = 'reupload';

    render(
      <UnifiedEditorHeaderBar
        filePath="/workspace/local.md"
        fileName="local.md"
        workspaceId="/workspace"
        isMarkdown
        lexicalEditor={lexicalEditor}
        showShareLinkButton={false}
        showCommonFileActions={false}
      />,
    );

    fireEvent.click(screen.getByTitle('Linked to team shared document'));
    expect(screen.getByRole('button', { name: 'Pull from Shared Doc' }).hasAttribute('disabled')).toBe(true);
  });
});
