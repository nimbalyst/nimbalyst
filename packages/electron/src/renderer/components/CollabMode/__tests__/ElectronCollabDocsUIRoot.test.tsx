/**
 * TabContent mounts every tab in its own `createRoot`, and React context does
 * not cross roots. When the Shared Docs Home tab was moved onto the extracted
 * `@nimbalyst/collab-client` list view (which reads `useCollabDocsUI`), that
 * root had no provider and the tab crashed with "Shared Docs UI must be
 * rendered inside CollabDocsUIProvider". `ElectronCollabDocsUIRoot` is the
 * context-only provider those detached roots mount.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

const scope: CollabScope = {
  scopeKey: '/workspace',
  orgId: 'org-1',
  indexConfig: { serverUrl: 'wss://example.test', teamProjectId: 'p1', teamMemberId: asTeamMemberId('u1') },
};
const session = { scope, host: {}, atoms: {} };

vi.mock('../../../store/atoms/collabDocuments', () => ({
  getElectronCollabDocsSession: () => session,
  trashSharedDocument: vi.fn(),
}));
vi.mock('../../../services/ElectronCollabHost', () => ({
  registerElectronCollabDocumentCreation: vi.fn(),
}));
vi.mock('../../../services/collaborativeDocumentCreationOrchestrator', () => ({
  createCollaborativeDocument: vi.fn(),
}));
vi.mock('../../../utils/sharedDocumentCleanup', () => ({ sweepEmptySharedDocuments: vi.fn() }));
vi.mock('../../../hooks/useDocUnread', () => ({ useDocUnread: vi.fn() }));
vi.mock('../../../hooks/useCollabLocalOrigin', () => ({ useCollabLocalOrigin: () => ({}) }));

const { ElectronCollabDocsUIRoot } = await import('../ElectronCollabDocsUIProvider');
const { useCollabDocsUI } = await import('@nimbalyst/collab-client/docs-ui');

function Consumer() {
  return <span>{useCollabDocsUI().scope.orgId}</span>;
}

describe('ElectronCollabDocsUIRoot', () => {
  it('supplies Shared Docs context to a tree in a detached React root', () => {
    render(
      <ElectronCollabDocsUIRoot scope={scope}>
        <Consumer />
      </ElectronCollabDocsUIRoot>,
    );
    expect(screen.getByText('org-1')).toBeDefined();
  });

  it('throws without it, which is the crash the Shared Home tab hit', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/must be rendered inside CollabDocsUIProvider/);
    quiet.mockRestore();
  });
});
