import { atom } from 'jotai';
import type { FeedbackRequestIndexEntry } from '@nimbalyst/collab-protocol';
import { asTeamMemberId, type TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

import type {
  FeedbackRequestServiceState,
  FeedbackRequestServiceTarget,
} from '../../../shared/feedbackRequest';
import {
  feedbackRequestIndexEntryHasSubject,
  type FeedbackRequestIndexTarget,
  type FeedbackRequestIndexViewerTarget,
  type FeedbackRequestSubjectRef,
} from '../../../shared/feedbackRequestIndex';
import { atomFamily } from '../debug/atomFamilyRegistry';

export function feedbackRequestAtomKey(
  target: FeedbackRequestServiceTarget & { teamMemberId: TeamMemberId },
): string {
  return JSON.stringify([
    target.workspacePath,
    target.orgId,
    target.teamMemberId,
    target.requestId,
  ]);
}

export function feedbackRequestTargetKey(
  target: FeedbackRequestServiceTarget,
): string {
  return JSON.stringify([
    target.workspacePath,
    target.orgId,
    target.requestId,
  ]);
}

function targetFromViewerKey(
  key: string,
): FeedbackRequestServiceTarget & { teamMemberId: TeamMemberId } {
  const [workspacePath, orgId, teamMemberId, requestId] = JSON.parse(key) as string[];
  return { workspacePath, orgId, teamMemberId: asTeamMemberId(teamMemberId), requestId };
}

function targetFromTargetKey(key: string): FeedbackRequestServiceTarget {
  const [workspacePath, orgId, requestId] = JSON.parse(key) as string[];
  return { workspacePath, orgId, requestId };
}

/** Written only by the renderer-wide feedback request IPC listener. */
export const feedbackRequestStateAtomFamily = atomFamily((key: string) =>
  atom<FeedbackRequestServiceState>({
    ...targetFromViewerKey(key),
    status: 'idle',
  }));

/** Current org-scoped viewer for a target, switched before projected state is exposed. */
export const feedbackRequestActiveViewerAtomFamily = atomFamily((targetKey: string) =>
  atom<TeamMemberId | ''>(''));

export type FeedbackRequestProjectedState = Omit<FeedbackRequestServiceState, 'teamMemberId'> & {
  teamMemberId: TeamMemberId | '';
};

/**
 * The active viewer's projection for a request. The indirection lets surfaces
 * address a request before main has returned the team member id without ever
 * placing two viewers' projected responses in the same atom.
 */
export const feedbackRequestStateForTargetAtomFamily = atomFamily((targetKey: string) =>
  atom<FeedbackRequestProjectedState>((get) => {
    const teamMemberId = get(feedbackRequestActiveViewerAtomFamily(targetKey));
    if (!teamMemberId) {
      return {
        ...targetFromTargetKey(targetKey),
        teamMemberId: '',
        status: 'idle' as const,
      };
    }
    return get(feedbackRequestStateAtomFamily(feedbackRequestAtomKey({
      ...targetFromTargetKey(targetKey),
      teamMemberId,
    })));
  }));

export const feedbackRequestAtomFamily = atomFamily((key: string) =>
  atom((get) => get(feedbackRequestStateForTargetAtomFamily(key)).request));

export const feedbackRequestProgressAtomFamily = atomFamily((key: string) =>
  atom((get) => get(feedbackRequestStateForTargetAtomFamily(key)).progress));

/**
 * Responses exactly as projected for this viewer by the server. This selector
 * deliberately performs no visibility or attribution filtering in the client.
 */
export const feedbackRequestResponsesForViewerAtomFamily = atomFamily(
  (key: string) => atom(
    (get) => get(feedbackRequestStateForTargetAtomFamily(key)).request?.responses ?? [],
  ),
);

export function feedbackRequestIndexTargetKey(
  target: FeedbackRequestIndexTarget,
): string {
  return JSON.stringify([target.workspacePath, target.orgId]);
}

export function feedbackRequestIndexViewerKey(
  target: FeedbackRequestIndexViewerTarget,
): string {
  return JSON.stringify([
    target.workspacePath,
    target.orgId,
    target.teamMemberId,
  ]);
}

export function feedbackRequestIndexSubjectKey(
  target: FeedbackRequestIndexTarget,
  subject: FeedbackRequestSubjectRef,
): string {
  return JSON.stringify([
    target.workspacePath,
    target.orgId,
    subject.kind,
    subject.sourceId,
  ]);
}

function feedbackRequestIndexTargetFromKey(
  key: string,
): FeedbackRequestIndexTarget {
  const [workspacePath, orgId] = JSON.parse(key) as string[];
  return { workspacePath, orgId };
}

function feedbackRequestIndexSubjectFromKey(key: string): {
  target: FeedbackRequestIndexTarget;
  subject: FeedbackRequestSubjectRef;
} {
  const [workspacePath, orgId, kind, sourceId] = JSON.parse(key) as string[];
  return {
    target: { workspacePath, orgId },
    subject: { kind: kind as FeedbackRequestSubjectRef['kind'], sourceId },
  };
}

/** Rows for one authenticated team-room viewer, written by the central listener. */
export const feedbackRequestIndexViewerEntriesAtomFamily = atomFamily((key: string) =>
  atom<FeedbackRequestIndexEntry[]>([]));

/** Current authenticated team-room viewer for a workspace/org index. */
export const feedbackRequestIndexActiveViewerAtomFamily = atomFamily((_key: string) =>
  atom<TeamMemberId | ''>(''));

/** Participant-filtered index list for the active local team identity. */
export const feedbackRequestIndexListAtomFamily = atomFamily((targetKey: string) =>
  atom((get) => {
    const teamMemberId = get(feedbackRequestIndexActiveViewerAtomFamily(targetKey));
    if (!teamMemberId) return [];
    return get(feedbackRequestIndexViewerEntriesAtomFamily(
      feedbackRequestIndexViewerKey({
        ...feedbackRequestIndexTargetFromKey(targetKey),
        teamMemberId,
      }),
    ));
  }));

/** Single subject-ref lookup shared by document and tracker backlink surfaces. */
export const feedbackRequestIndexBySubjectAtomFamily = atomFamily((subjectKey: string) =>
  atom((get) => {
    const { target, subject } = feedbackRequestIndexSubjectFromKey(subjectKey);
    return get(feedbackRequestIndexListAtomFamily(
      feedbackRequestIndexTargetKey(target),
    )).filter((entry) => feedbackRequestIndexEntryHasSubject(entry, subject));
  }));
