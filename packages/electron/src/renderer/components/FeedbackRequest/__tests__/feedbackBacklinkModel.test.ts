// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import type { FeedbackRequestIndexEntry } from '@nimbalyst/collab-protocol';

import {
  feedbackBacklinkAuthorLabel,
  feedbackBacklinkStatus,
  sortFeedbackBacklinks,
} from '../feedbackBacklinkModel';

function entry(over: Partial<FeedbackRequestIndexEntry>): FeedbackRequestIndexEntry {
  return {
    requestId: 'request-1',
    urn: 'nimbalyst://feedback-request/request-1',
    orgId: 'org-1',
    title: 'Which onboarding flow should we ship?',
    author: { kind: 'user', onBehalfOfUserId: 'member-a' },
    recipients: [],
    lifecycle: { status: 'open', changedAt: 1 },
    progress: {
      answeredAskCount: 0,
      totalAssignedAskCount: 0,
      answeredRecipientCount: 0,
      totalRecipientCount: 3,
      quorumReached: false,
    },
    subjects: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('feedback backlink presentation model', () => {
  it('reads an open request that reached quorum as answered, not as still waiting', () => {
    const waiting = entry({});
    const satisfied = entry({
      progress: { ...waiting.progress, answeredRecipientCount: 2, quorumReached: true },
    });

    expect(feedbackBacklinkStatus(waiting)).toEqual({ label: 'Open', tone: 'open' });
    expect(feedbackBacklinkStatus(satisfied)).toEqual({ label: 'Answered', tone: 'answered' });
    expect(feedbackBacklinkStatus(entry({ lifecycle: { status: 'cancelled', changedAt: 2 } })))
      .toEqual({ label: 'Cancelled', tone: 'closed' });
  });

  it('omits an author the index cannot identify', () => {
    // Another member's id is not a name -- the index carries resolved names for
    // recipients only, so there is nothing truthful to show.
    expect(feedbackBacklinkAuthorLabel(entry({}), asTeamMemberId('member-b'))).toBeNull();
  });

  it('orders backlinks by most recent activity', () => {
    const ordered = sortFeedbackBacklinks([
      entry({ requestId: 'stale', updatedAt: 10 }),
      entry({ requestId: 'live', updatedAt: 90 }),
      entry({ requestId: 'middle', updatedAt: 50 }),
    ]);
    expect(ordered.map((item) => item.requestId)).toEqual(['live', 'middle', 'stale']);
  });
});
