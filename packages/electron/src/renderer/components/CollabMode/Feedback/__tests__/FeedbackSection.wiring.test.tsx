// @vitest-environment jsdom
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
import { render, screen } from '@testing-library/react';
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
  it('lists the entries the index listener wrote for the active viewer', () => {
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

    expect(screen.getByTestId('feedback-row').dataset.requestId).toBe('req-1');
  });
});
