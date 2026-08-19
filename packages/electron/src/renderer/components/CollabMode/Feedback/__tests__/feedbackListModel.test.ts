// @vitest-environment node
/**
 * What the feedback list decides that a reader cannot see on screen: which
 * requests a viewer-scoped filter admits, and which face of a request opening a
 * row lands on.
 *
 * The index carries no asks and no responses, so every question here is
 * answered from participation plus aggregate progress. The interesting cases
 * are the ones where those two disagree with intuition — an author who is also
 * a recipient, quorum reached while people are still outstanding, and the three
 * different terminal lifecycles that all read as "closed".
 */

import { describe, expect, it } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import type {
  FeedbackRequestIndexEntry,
  FeedbackRequestReadModel,
} from '@nimbalyst/collab-protocol';

import {
  feedbackListStatus,
  isViewerAuthor,
  needsViewerResponse,
  selectFeedbackRows,
  toFeedbackRowView,
} from '../feedbackListModel';
import { feedbackRequestViewMode } from '../../../FeedbackRequest/feedbackRequestViewMode';

const VIEWER = asTeamMemberId('member-viewer');
const PEER = asTeamMemberId('member-peer');

function entry(
  overrides: Partial<FeedbackRequestIndexEntry> = {},
): FeedbackRequestIndexEntry {
  return {
    requestId: 'req-1',
    urn: 'nimbalyst://feedback-request/req-1',
    orgId: 'org-1',
    title: 'Which onboarding flow should we ship?',
    author: { kind: 'user', userId: PEER, onBehalfOfUserId: PEER },
    recipients: [
      { userId: VIEWER, name: 'Viewer' },
      { userId: PEER, name: 'Peer' },
    ],
    lifecycle: { status: 'open', changedAt: 1_000 },
    progress: {
      answeredAskCount: 0,
      totalAssignedAskCount: 2,
      answeredRecipientCount: 0,
      totalRecipientCount: 2,
      quorumReached: false,
    },
    subjects: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as FeedbackRequestIndexEntry;
}

describe('needsViewerResponse', () => {
  it('admits an author who put themselves on the recipient list', () => {
    const authoredByViewer = entry({
      author: { kind: 'user', userId: VIEWER, onBehalfOfUserId: VIEWER },
    });
    expect(isViewerAuthor(authoredByViewer, VIEWER)).toBe(true);
    expect(needsViewerResponse(authoredByViewer, VIEWER)).toBe(true);
  });

  it('drops an author who is not a recipient, however outstanding the request', () => {
    expect(needsViewerResponse(
      entry({ recipients: [{ userId: PEER, name: 'Peer' }] }),
      VIEWER,
    )).toBe(false);
  });

  it('drops a recipient once every recipient has answered', () => {
    expect(needsViewerResponse(
      entry({
        progress: {
          answeredAskCount: 2,
          totalAssignedAskCount: 2,
          answeredRecipientCount: 2,
          totalRecipientCount: 2,
          quorumReached: true,
        },
      }),
      VIEWER,
    )).toBe(false);
  });

  it('drops every recipient once the request stops taking answers', () => {
    for (const status of ['closed', 'expired', 'cancelled'] as const) {
      expect(needsViewerResponse(
        entry({ lifecycle: { status, changedAt: 2_000 } }),
        VIEWER,
      )).toBe(false);
    }
  });

  it('claims nobody when there is no resolved viewer identity', () => {
    expect(needsViewerResponse(entry(), '')).toBe(false);
    expect(isViewerAuthor(entry(), '')).toBe(false);
  });
});

describe('isViewerAuthor', () => {
  it('counts a request an agent sent on the viewer’s behalf as theirs', () => {
    const agentAuthored = entry({
      author: {
        kind: 'agent',
        sessionId: 'session-9',
        sessionName: 'Planning session',
        onBehalfOfUserId: VIEWER,
      },
    });
    expect(isViewerAuthor(agentAuthored, VIEWER)).toBe(true);
    expect(isViewerAuthor(agentAuthored, PEER)).toBe(false);
  });
});

describe('feedbackListStatus', () => {
  it('reads as answered once quorum is met, even with recipients outstanding', () => {
    const quorate = entry({
      progress: {
        answeredAskCount: 2,
        totalAssignedAskCount: 4,
        answeredRecipientCount: 1,
        totalRecipientCount: 2,
        quorumReached: true,
      },
    });
    expect(feedbackListStatus(quorate)).toBe('answered');
    // …and the recipient who has not answered is still asked for one.
    expect(needsViewerResponse(quorate, VIEWER)).toBe(true);
  });

  it('keeps the three terminal lifecycles distinct while grouping them as closed', () => {
    const rows = selectFeedbackRows({
      entries: [
        entry({ requestId: 'a', lifecycle: { status: 'closed', changedAt: 2_000 } }),
        entry({ requestId: 'b', lifecycle: { status: 'expired', changedAt: 2_000 } }),
        entry({ requestId: 'c', lifecycle: { status: 'cancelled', changedAt: 2_000 } }),
      ],
      filter: 'closed',
      query: '',
      viewerUserId: VIEWER,
    });
    expect(rows.entries.map((row) => row.requestId)).toEqual(['a', 'b', 'c']);
    expect(rows.entries.map(feedbackListStatus)).toEqual([
      'closed',
      'expired',
      'cancelled',
    ]);
  });
});

describe('selectFeedbackRows', () => {
  const entries = [
    // Open, viewer is a recipient with the request outstanding.
    entry({ requestId: 'needs-me' }),
    // Sent by the viewer, answered by everyone.
    entry({
      requestId: 'mine',
      author: { kind: 'user', userId: VIEWER, onBehalfOfUserId: VIEWER },
      recipients: [{ userId: PEER, name: 'Peer' }],
      progress: {
        answeredAskCount: 1,
        totalAssignedAskCount: 1,
        answeredRecipientCount: 1,
        totalRecipientCount: 1,
        quorumReached: true,
      },
    }),
    // Closed, and about an artifact.
    entry({
      requestId: 'done',
      title: 'Approve the web console palette',
      lifecycle: { status: 'closed', changedAt: 2_000 },
      subjects: [{
        label: 'web-console-theme.md',
        ref: {
          kind: 'document',
          orgId: 'org-1',
          sourceId: 'doc-7',
        },
      }] as FeedbackRequestIndexEntry['subjects'],
    }),
  ];

  it('counts every filter over the whole index, not over the search result', () => {
    const { entries: visible, counts } = selectFeedbackRows({
      entries,
      filter: 'all',
      query: 'palette',
      viewerUserId: VIEWER,
    });
    expect(visible.map((row) => row.requestId)).toEqual(['done']);
    expect(counts).toEqual({
      needsMyResponse: 1,
      sentByMe: 1,
      open: 1,
      answered: 1,
      closed: 1,
      all: 3,
    });
  });

  it('searches the frozen subject labels and recipient names, not just titles', () => {
    const bySubject = selectFeedbackRows({
      entries,
      filter: 'all',
      query: 'web-console-theme',
      viewerUserId: VIEWER,
    });
    expect(bySubject.entries.map((row) => row.requestId)).toEqual(['done']);
    const byRecipient = selectFeedbackRows({
      entries,
      filter: 'all',
      query: 'peer',
      viewerUserId: VIEWER,
    });
    expect(byRecipient.entries.map((row) => row.requestId)).toEqual([
      'needs-me',
      'mine',
      'done',
    ]);
  });

  it('shows the viewer nothing personal before their team identity resolves', () => {
    const { counts } = selectFeedbackRows({
      entries,
      filter: 'all',
      query: '',
      viewerUserId: '',
    });
    expect(counts.needsMyResponse).toBe(0);
    expect(counts.sentByMe).toBe(0);
    expect(counts.all).toBe(3);
  });
});

describe('toFeedbackRowView', () => {
  it('carries viewer-response status into the row view', () => {
    const row = toFeedbackRowView({
      entry: entry({ subjects: [] }),
      viewerUserId: VIEWER,
      memberNames: { [PEER]: 'Priya Raman' },
      now: 1_000,
    });
    expect(row.needsViewerResponse).toBe(true);
  });
});

/**
 * The respond/results choice is made from the request the room projected for
 * this viewer, which is the only place per-viewer answer state exists.
 */
describe('feedbackRequestViewMode', () => {
  function request(
    overrides: Partial<FeedbackRequestReadModel> = {},
  ): FeedbackRequestReadModel {
    return {
      id: 'req-1',
      urn: 'nimbalyst://feedback-request/req-1',
      orgId: 'org-1',
      author: { kind: 'user', userId: PEER, onBehalfOfUserId: PEER },
      subjects: [],
      asks: [
        { id: 'ask-1', type: 'confirm', label: 'Ship Tuesday?' },
        { id: 'ask-2', type: 'confirm', label: 'Blockers?' },
      ],
      recipients: [{ userId: VIEWER, name: 'Viewer' }],
      assignments: [
        { askId: 'ask-1', target: { kind: 'user', userId: VIEWER } },
        { askId: 'ask-2', target: { kind: 'user', userId: VIEWER } },
      ],
      responses: [],
      discussion: [],
      lifecycle: { status: 'open', changedAt: 1_000 },
      visibility: 'open',
      wakePolicy: 'quorumOrClose',
      quorum: { requiredRecipientCount: 1 },
      createdAt: 1_000,
      updatedAt: 1_000,
      ...overrides,
    } as FeedbackRequestReadModel;
  }

  const answer = (askId: string) => ({
    id: `res-${askId}`,
    requestId: 'req-1',
    askId,
    recipientUserId: VIEWER,
    answer: { type: 'confirm' as const, value: true },
    createdAt: 1_100,
    updatedAt: 1_100,
  });

  it('asks a recipient who still owes an answer', () => {
    expect(feedbackRequestViewMode(request(), VIEWER)).toBe('respond');
    expect(feedbackRequestViewMode(
      request({ responses: [answer('ask-1')] as FeedbackRequestReadModel['responses'] }),
      VIEWER,
    )).toBe('respond');
  });

  it('shows tallies once the viewer has answered everything assigned to them', () => {
    expect(feedbackRequestViewMode(
      request({
        responses: [answer('ask-1'), answer('ask-2')] as FeedbackRequestReadModel['responses'],
      }),
      VIEWER,
    )).toBe('results');
  });

  it('shows tallies to the author, to a bystander, and once the request closes', () => {
    expect(feedbackRequestViewMode(request(), PEER)).toBe('results');
    expect(feedbackRequestViewMode(request(), asTeamMemberId('member-stranger'))).toBe('results');
    expect(feedbackRequestViewMode(
      request({ lifecycle: { status: 'closed', changedAt: 2_000 } }),
      VIEWER,
    )).toBe('results');
  });

  it('falls back to tallies before the room or the viewer resolves', () => {
    expect(feedbackRequestViewMode(undefined, VIEWER)).toBe('results');
    expect(feedbackRequestViewMode(request(), '')).toBe('results');
  });
});
