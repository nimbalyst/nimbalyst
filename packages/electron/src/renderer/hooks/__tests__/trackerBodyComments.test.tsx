// @vitest-environment jsdom

import React, { useMemo } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  notifyDocumentCommentRecipients: vi.fn(),
}));

vi.mock('@nimbalyst/runtime/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nimbalyst/runtime/sync')>();
  const Y = await import('yjs');

  class FakeDocumentSyncProvider {
    private readonly doc = new Y.Doc();
    private status = 'disconnected';

    constructor(private readonly config: any) {}

    getYDoc() {
      return this.doc;
    }

    getStatus() {
      return this.status;
    }

    isSynced() {
      return this.status === 'connected';
    }

    async connect() {
      if (this.status === 'connected') return;
      this.status = 'connected';
      this.config.onStatusChange?.('connected');
    }

    disconnect() {}
    destroy() {}
    onAwarenessChange() {
      return () => {};
    }
    setLocalAwareness() {}
    setRoomMetadata() {}
  }

  return { ...actual, DocumentSyncProvider: FakeDocumentSyncProvider };
});

vi.mock('../../utils/collabDocumentOpener', () => ({
  resolveDesktopCollabConfigForUri: vi.fn(
    async (scopeKey: string, _uri: string, documentId: string) => ({
      scope: {
        scopeKey,
        orgId: 'org-1',
        indexConfig: { serverUrl: 'wss://test.invalid', userId: 'user-1' },
      },
      serverUrl: 'wss://test.invalid',
      getJwt: async () => 'jwt',
      orgId: 'org-1',
      userId: 'user-1',
      userName: 'Tracker Author',
      userEmail: 'author@example.com',
      documentId,
      createWebSocket: () => {
        throw new Error('transport is faked');
      },
    }),
  ),
}));

vi.mock('../../store/atoms/collabDocuments', () => ({
  getTeamSyncProviderForScopeKey: () => ({
    getTeamState: () => ({
      members: [
        {
          userId: 'user-2',
          email: 'reviewer@example.com',
          personalOrgId: 'personal-2',
        },
      ],
    }),
  }),
}));

vi.mock('../../services/documentCommentNotifier', () => ({
  notifyDocumentCommentRecipients: h.notifyDocumentCommentRecipients,
}));

vi.mock('@nimbalyst/collab-adapters', () => ({
  getCollabContentAdapter: () => null,
  exportCollabRecoveryPlaintext: () => null,
}));

import {
  collabCommentControllerRegistry,
  NimbalystEditor,
} from '@nimbalyst/runtime/editor';
import type { EditorConfig } from '@nimbalyst/runtime/editor';
import { useTrackerContentCollab } from '../useTrackerContentCollab';
import { _resetBodyDocCacheForTests } from '../../services/BodyDocCache';

const ITEM_ID = 'tracker-comment-item';
const DOCUMENT_URI =
  `collab://org:org-1:doc:tracker-content/${ITEM_ID}`;
const BODY = 'Tracker comment target';

function TrackerBodyEditor(): React.ReactElement {
  const {
    collaboration,
    commentsConfig,
    loading,
    providerEpoch,
  } = useTrackerContentCollab({
    itemId: ITEM_ID,
    title: 'NIM-COMMENT',
    workspacePath: '/workspace',
    syncMode: 'shared',
    teamOrgId: 'org-1',
    itemShared: true,
  });

  const config = useMemo<EditorConfig | null>(() => {
    if (!collaboration || !commentsConfig || loading) return null;
    return {
      isRichText: true,
      editable: true,
      showToolbar: false,
      isCodeHighlighted: true,
      hasLinkAttributes: true,
      markdownOnly: true,
      collaboration,
      comments: commentsConfig,
    };
  }, [collaboration, commentsConfig, loading]);

  if (!config) return <div data-testid="tracker-comment-editor-loading" />;
  return (
    <NimbalystEditor
      key={`collab-${ITEM_ID}-${providerEpoch}`}
      config={config}
    />
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  _resetBodyDocCacheForTests();
  collabCommentControllerRegistry.clear();
  h.notifyDocumentCommentRecipients.mockClear();

  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (window as any).matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  (window as any).electronAPI = {
    documentService: {
      getTrackerBodyCacheForDetail: vi.fn(async () => ({
        success: true,
        row: { content: BODY },
      })),
    },
    collabBackup: {
      contentChanged: vi.fn(async () => undefined),
    },
  };
});

afterEach(() => {
  cleanup();
  collabCommentControllerRegistry.clear();
  _resetBodyDocCacheForTests();
});

describe('tracker body inline comment controller', () => {
  it('registers under the body collab URI so MCP create/list operations resolve', async () => {
    const view = render(<TrackerBodyEditor />);
    await settle();

    const controller = collabCommentControllerRegistry.get(DOCUMENT_URI);
    expect(controller).toBeDefined();
    if (!controller) throw new Error('tracker body comment controller did not register');
    expect(controller.isHydrated()).toBe(true);

    const actor = controller.createAgentActor({
      sessionId: 'session-1',
      sessionName: 'Comment Agent',
    });
    let created: Awaited<ReturnType<typeof controller.createAnchored>>;
    await act(async () => {
      created = await controller.createAnchored({
        anchor: { exact: BODY },
        body: 'Review this tracker body.',
        clientMutationId: 'tracker-comment-mutation-1',
        mentionedUserIds: ['user-2'],
      }, actor);
    });

    expect(created!.duplicate).toBe(false);
    expect(controller.list().threads).toHaveLength(1);
    expect(controller.list().threads[0].comments[0].body).toBe(
      'Review this tracker body.',
    );
    expect(h.notifyDocumentCommentRecipients).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: '/workspace',
        documentId: `tracker-content/${ITEM_ID}`,
        reason: 'mention',
        recipientUserIds: ['user-2'],
      }),
    );

    view.unmount();
    await settle();
    expect(collabCommentControllerRegistry.has(DOCUMENT_URI)).toBe(false);
  });
});
