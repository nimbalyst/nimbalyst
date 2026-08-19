// @vitest-environment node

import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import {
  feedbackRequestActiveViewerAtomFamily,
  feedbackRequestAtomKey,
  feedbackRequestStateAtomFamily,
  feedbackRequestStateForTargetAtomFamily,
  feedbackRequestTargetKey,
  feedbackRequestIndexActiveViewerAtomFamily,
  feedbackRequestIndexBySubjectAtomFamily,
  feedbackRequestIndexListAtomFamily,
  feedbackRequestIndexSubjectKey,
  feedbackRequestIndexTargetKey,
  feedbackRequestIndexViewerEntriesAtomFamily,
  feedbackRequestIndexViewerKey,
} from '../feedbackRequests';

const TARGET = {
  workspacePath: '/work/acme',
  orgId: 'org-1',
  requestId: 'request-1',
};

describe('feedback request viewer projections', () => {
  it('switches viewers without exposing the previous viewer projection', () => {
    const store = createStore();
    const targetKey = feedbackRequestTargetKey(TARGET);
    const firstKey = feedbackRequestAtomKey({ ...TARGET, teamMemberId: asTeamMemberId('member-a') });
    const secondKey = feedbackRequestAtomKey({ ...TARGET, teamMemberId: asTeamMemberId('member-b') });

    store.set(feedbackRequestStateAtomFamily(firstKey), {
      ...TARGET,
      teamMemberId: asTeamMemberId('member-a'),
      status: 'cached',
      request: { responses: [{ id: 'visible-only-to-a' }] } as never,
    });
    store.set(feedbackRequestActiveViewerAtomFamily(targetKey), asTeamMemberId('member-a'));
    expect(
      store.get(feedbackRequestStateForTargetAtomFamily(targetKey)).request?.responses,
    ).toEqual([{ id: 'visible-only-to-a' }]);

    store.set(feedbackRequestActiveViewerAtomFamily(targetKey), asTeamMemberId('member-b'));
    expect(store.get(feedbackRequestStateForTargetAtomFamily(targetKey))).toMatchObject({
      teamMemberId: 'member-b',
      status: 'idle',
    });
    expect(store.get(feedbackRequestStateForTargetAtomFamily(targetKey)).request)
      .toBeUndefined();

    store.set(feedbackRequestStateAtomFamily(secondKey), {
      ...TARGET,
      teamMemberId: asTeamMemberId('member-b'),
      status: 'cached',
      request: { responses: [] } as never,
    });
    expect(
      store.get(feedbackRequestStateForTargetAtomFamily(targetKey)).request?.responses,
    ).toEqual([]);
  });

  it('shares one viewer-safe list between document and tracker subject lookups', () => {
    const store = createStore();
    const indexTarget = { workspacePath: TARGET.workspacePath, orgId: TARGET.orgId };
    const targetKey = feedbackRequestIndexTargetKey(indexTarget);
    const viewerKey = feedbackRequestIndexViewerKey({
      ...indexTarget,
      teamMemberId: asTeamMemberId('member-a'),
    });
    const base = {
      orgId: TARGET.orgId,
      author: { kind: 'user' as const, onBehalfOfUserId: 'author-a' },
      recipients: [],
      lifecycle: { status: 'open' as const, changedAt: 1 },
      progress: {
        answeredAskCount: 0,
        totalAssignedAskCount: 0,
        answeredRecipientCount: 0,
        totalRecipientCount: 0,
        quorumReached: false,
      },
      createdAt: 1,
      updatedAt: 1,
    };
    store.set(feedbackRequestIndexViewerEntriesAtomFamily(viewerKey), [{
      ...base,
      requestId: 'doc-request',
      urn: 'nimbalyst://feedback-request/doc-request',
      title: 'Document feedback',
      subjects: [{
        ref: { orgId: TARGET.orgId, kind: 'document', sourceId: 'doc-1' },
        label: 'Doc',
      }],
    }, {
      ...base,
      requestId: 'tracker-request',
      urn: 'nimbalyst://feedback-request/tracker-request',
      title: 'Tracker feedback',
      subjects: [{
        ref: { orgId: TARGET.orgId, kind: 'tracker', sourceId: 'tracker-1' },
        label: 'Tracker',
      }],
    }]);
    store.set(feedbackRequestIndexActiveViewerAtomFamily(targetKey), asTeamMemberId('member-a'));

    expect(store.get(feedbackRequestIndexListAtomFamily(targetKey))).toHaveLength(2);
    expect(store.get(feedbackRequestIndexBySubjectAtomFamily(
      feedbackRequestIndexSubjectKey(indexTarget, {
        kind: 'document', sourceId: 'doc-1',
      }),
    )).map((entry) => entry.requestId)).toEqual(['doc-request']);
    expect(store.get(feedbackRequestIndexBySubjectAtomFamily(
      feedbackRequestIndexSubjectKey(indexTarget, {
        kind: 'tracker', sourceId: 'tracker-1',
      }),
    )).map((entry) => entry.requestId)).toEqual(['tracker-request']);

    store.set(feedbackRequestIndexActiveViewerAtomFamily(targetKey), asTeamMemberId('member-b'));
    expect(store.get(feedbackRequestIndexListAtomFamily(targetKey))).toEqual([]);
  });

  it('backlinks a multi-subject request from each artifact, and never across kinds', () => {
    const store = createStore();
    const indexTarget = { workspacePath: TARGET.workspacePath, orgId: TARGET.orgId };
    const targetKey = feedbackRequestIndexTargetKey(indexTarget);
    const viewerKey = feedbackRequestIndexViewerKey({
      ...indexTarget,
      teamMemberId: asTeamMemberId('member-a'),
    });
    // Same sourceId under two kinds: a tracker item and a document can collide,
    // and matching on the id alone would cross-link two unrelated artifacts.
    const collidingId = 'shared-id';
    store.set(feedbackRequestIndexViewerEntriesAtomFamily(viewerKey), [{
      requestId: 'multi-subject',
      urn: 'nimbalyst://feedback-request/multi-subject',
      orgId: TARGET.orgId,
      title: 'Ship the onboarding flow?',
      author: { kind: 'user' as const, onBehalfOfUserId: 'author-a' },
      recipients: [],
      lifecycle: { status: 'open' as const, changedAt: 1 },
      progress: {
        answeredAskCount: 0,
        totalAssignedAskCount: 0,
        answeredRecipientCount: 0,
        totalRecipientCount: 0,
        quorumReached: false,
      },
      subjects: [
        { ref: { orgId: TARGET.orgId, kind: 'document', sourceId: 'doc-1' }, label: 'Doc' },
        { ref: { orgId: TARGET.orgId, kind: 'document', sourceId: 'doc-2' }, label: 'Doc 2' },
        { ref: { orgId: TARGET.orgId, kind: 'tracker', sourceId: collidingId }, label: 'Item' },
      ],
      createdAt: 1,
      updatedAt: 1,
    }]);
    store.set(feedbackRequestIndexActiveViewerAtomFamily(targetKey), asTeamMemberId('member-a'));

    const idsFor = (subject: { kind: 'document' | 'tracker'; sourceId: string }) =>
      store.get(feedbackRequestIndexBySubjectAtomFamily(
        feedbackRequestIndexSubjectKey(indexTarget, subject),
      )).map((entry) => entry.requestId);

    expect(idsFor({ kind: 'document', sourceId: 'doc-1' })).toEqual(['multi-subject']);
    expect(idsFor({ kind: 'document', sourceId: 'doc-2' })).toEqual(['multi-subject']);
    expect(idsFor({ kind: 'tracker', sourceId: collidingId })).toEqual(['multi-subject']);
    expect(idsFor({ kind: 'document', sourceId: collidingId })).toEqual([]);
    expect(idsFor({ kind: 'tracker', sourceId: 'doc-1' })).toEqual([]);
    // An artifact nobody asked about has nothing for a host surface to render.
    expect(idsFor({ kind: 'document', sourceId: 'untouched-doc' })).toEqual([]);
  });
});
