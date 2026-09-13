// @vitest-environment jsdom
import { documentFeedbackIndexesAtom } from '../../../../store/atoms/documentFeedback';
/**
 * The one thing about this surface that is invisible on screen: which atom key
 * it reads.
 *
 * Entries are written by the central index listener under
 * `feedbackRequestIndexViewerKey({workspacePath, orgId, viewerUserId})`, and
 * the surface addresses them through `feedbackRequestIndexTargetKey` plus the
 * active viewer. Those two derivations live in different modules, and if they
 * drift the list is silently empty forever — which is indistinguishable from
 * "you have no feedback requests". Hence a wiring test rather than a render
 * test: it writes the atoms exactly as the listener does and asserts a row
 * comes out the other end.
 */

import React from 'react';
import { Provider, createStore } from 'jotai';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FeedbackRequestIndexEntry } from '@nimbalyst/collab-protocol';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import {
  feedbackRequestIndexActiveViewerAtomFamily,
  feedbackRequestIndexTargetKey,
  feedbackRequestIndexViewerEntriesAtomFamily,
  feedbackRequestIndexViewerKey,
} from '../../../../store/atoms/feedbackRequests';
import { FeedbackSection } from '../FeedbackSection';

const TARGET = { workspacePath: '/workspace', orgId: 'org-1' };

const ENTRY = {
  requestId: 'req-1',
  urn: 'nimbalyst://feedback-request/req-1',
  orgId: 'org-1',
  title: 'Which onboarding flow should we ship?',
  author: { kind: 'user', userId: 'peer', onBehalfOfUserId: 'peer' },
  recipients: [{ userId: 'me', name: 'Me' }],
  lifecycle: { status: 'open', changedAt: 1 },
  progress: {
    answeredAskCount: 0,
    totalAssignedAskCount: 1,
    answeredRecipientCount: 0,
    totalRecipientCount: 1,
    quorumReached: false,
  },
  subjects: [],
  createdAt: 1,
  updatedAt: 1,
} as FeedbackRequestIndexEntry;

describe('FeedbackSection', () => {
  it('lists the entries the index listener wrote for the active viewer', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { invoke: vi.fn().mockResolvedValue({ entries: [] }) },
    });
    const store = createStore();
    store.set(
      feedbackRequestIndexActiveViewerAtomFamily(feedbackRequestIndexTargetKey(TARGET)),
      asTeamMemberId('me'),
    );
    store.set(
      feedbackRequestIndexViewerEntriesAtomFamily(
        feedbackRequestIndexViewerKey({ ...TARGET, teamMemberId: asTeamMemberId('me') }),
      ),
      [ENTRY],
    );

    render(
      <Provider store={store}>
        <FeedbackSection
          orgId={TARGET.orgId}
          workspacePath={TARGET.workspacePath}
          now={2}
        />
      </Provider>,
    );

    await waitFor(() => expect(screen.getByTestId('feedback-row').dataset.requestId).toBe('request:req-1'));
  });
});


it('finds sent document questions without a legacy request and opens the exact block', async () => {
  const invoke = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
  const store = createStore();
  store.set(documentFeedbackIndexesAtom, {
    [feedbackRequestIndexTargetKey(TARGET)]: {
      ...TARGET, teamMemberId: 'me', state: { epoch: 'one', sequence: 1, generation: 1, status: 'ready', entries: [{
        orgId: 'org-1', projectId: 'project', documentId: 'doc', blockId: 'question / 1', title: 'Document question',
        sentBy: 'me', sentAt: 1, updatedAt: 1, sealed: false, availability: 'available', recipientCount: 1,
        answeredCount: 0, quorum: 1, isRecipient: false, needsMyResponse: false,
      }] },
    },
  });
  render(<Provider store={store}><FeedbackSection orgId="org-1" workspacePath="/workspace" now={2} /></Provider>);
  fireEvent.click(screen.getByTestId('feedback-filter-sentByMe'));
  fireEvent.click(screen.getByText('Document question'));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('deep-link:open-inbox-source', 'nimbalyst://doc/doc?orgId=org-1&projectId=project&blockId=question+%2F+1'));
});
