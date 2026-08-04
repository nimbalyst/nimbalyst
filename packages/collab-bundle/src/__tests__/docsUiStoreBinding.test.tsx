import React from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CollabDocsUIProvider,
  CollabSidebar,
  createCollabDocsSession,
  pruneCollabDocsSession,
} from '@nimbalyst/collab-bundle/docs-ui';

const SCOPE_KEY = 'built-docs-ui-store-binding';

afterEach(() => {
  cleanup();
  pruneCollabDocsSession(SCOPE_KEY);
});

describe('built Shared Docs UI store binding', () => {
  it('renders a session snapshot written through the bundled runtime store', async () => {
    type CreateSessionArgs = Parameters<typeof createCollabDocsSession>;
    const scope: CreateSessionArgs[0] = {
      scopeKey: SCOPE_KEY,
      orgId: 'org-built-entry',
      indexConfig: {
        serverUrl: 'ws://sync.test',
        teamProjectId: 'project-built-entry',
        userId: 'member-built-entry',
      },
    };
    const dataSource: CreateSessionArgs[1] = {
      snapshot: vi.fn(async () => ({
        containers: [{
          folderId: 'folder-built-entry',
          parentFolderId: null,
          name: 'Seeded folder',
          sortOrder: 0,
          createdBy: 'member-built-entry',
          createdAt: 1,
          updatedAt: 1,
        }],
        items: [{
          documentId: 'document-built-entry',
          teamProjectId: 'project-built-entry',
          title: 'Seeded document.md',
          documentType: 'markdown',
          createdBy: 'member-built-entry',
          createdAt: 1,
          updatedAt: 2,
          lastWriterUserId: 'member-built-entry',
          parentFolderId: 'folder-built-entry',
        }],
      })),
      subscribe: vi.fn((listener) => {
        listener({ type: 'status', status: 'connected' });
        return () => undefined;
      }),
      command: vi.fn(async () => ({ ok: true as const })),
      status: () => 'connected',
      dispose: vi.fn(),
    };
    const documentTypes = [] as const;
    const host = {
      surface: 'web_console' as const,
      resolveScope: async () => scope,
      onScopeChanged: () => () => undefined,
      getTeamJwt: async () => { throw new Error('unused'); },
      getMembers: async () => [],
      openArtifact: vi.fn(),
      personalState: { status: 'unavailable' as const },
      documents: {
        dataSource,
        loadViewPreferences: async () => null,
        saveViewPreferences: async () => undefined,
        documentTypes: () => documentTypes,
        createDocument: async () => undefined,
        readReceipts: { status: 'unavailable' as const },
      },
    } as unknown as CreateSessionArgs[2];
    const session = createCollabDocsSession(scope, dataSource, host);

    const surface = render(
      <CollabDocsUIProvider session={session}>
        <CollabSidebar />
      </CollabDocsUIProvider>,
    );

    expect(surface.queryByText('Seeded document.md')).toBeNull();
    await act(async () => {
      await session.start();
    });

    fireEvent.click(await surface.findByText('Seeded folder'));
    surface.getByText('Seeded document.md');
    surface.getByText('Team synced');
  });
});
