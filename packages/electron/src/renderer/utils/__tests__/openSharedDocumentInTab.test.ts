// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import {
  activeCollabScopeAtom,
  pendingCollabDocumentAtom,
} from '../../store/atoms/collabDocuments';
import { windowModeAtom } from '../../store/atoms/windowMode';
import { openSharedDocumentInTab } from '../openSharedDocumentInTab';

const SCOPE = {
  scopeKey: '/workspace/design',
  orgId: 'org-1',
  indexConfig: {
    serverUrl: 'wss://sync.example.test',
    teamProjectId: 'project-design',
    teamMemberId: asTeamMemberId('user-1'),
  },
};

afterEach(() => {
  store.set(activeCollabScopeAtom, null);
  store.set(pendingCollabDocumentAtom, null);
  store.set(windowModeAtom, 'files');
});

describe('openSharedDocumentInTab', () => {
  it('opens a feedback artifact only in its owning project scope', () => {
    store.set(activeCollabScopeAtom, SCOPE);
    store.set(windowModeAtom, 'collab');
    const ref = {
      orgId: 'org-1',
      projectId: 'project-design',
      kind: 'document' as const,
      sourceId: 'document-1',
    };

    expect(openSharedDocumentInTab(ref, 'feedback_request')).toBe(true);
    expect(store.get(pendingCollabDocumentAtom)).toMatchObject({
      documentId: 'document-1',
      scopeKey: SCOPE.scopeKey,
      orgId: SCOPE.orgId,
    });
  });

  it('refuses to route a document id through the wrong project room', () => {
    store.set(activeCollabScopeAtom, SCOPE);
    store.set(windowModeAtom, 'collab');
    const ref = {
      orgId: 'org-1',
      projectId: 'project-research',
      kind: 'document' as const,
      sourceId: 'document-1',
    };

    expect(openSharedDocumentInTab(ref, 'feedback_request')).toBe(false);
    expect(store.get(pendingCollabDocumentAtom)).toBeNull();
  });
});
