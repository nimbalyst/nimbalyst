// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  draftRequestFeedback,
  handleRequestFeedback,
} from '../requestFeedbackToolHandler';
import type {
  OrgDirectoryResult,
  ResourceSharingResult,
} from '../collabReadToolHandlers';

const WORKSPACE = '/workspace/design';
const ORG = { orgId: 'org-design', name: 'Design Team', teamProjectId: 'project-design' };

function matched(memberId: string, displayName: string, email: string): OrgDirectoryResult {
  return {
    status: 'matched',
    message: 'Matched one member in Design Team.',
    org: ORG,
    members: [{ memberId, displayName, email }],
  };
}

function sharing(
  kind: ResourceSharingResult['kind'],
  sourceId: string,
  teamVisible: boolean,
): ResourceSharingResult {
  return {
    kind,
    sourceId,
    teamVisible,
    orgId: teamVisible ? ORG.orgId : null,
    reason: teamVisible ? 'shared' : 'notShared',
  };
}

const confirmAsk = {
  type: 'confirm',
  id: 'approve',
  label: 'Approve',
  description: 'Does this direction work?',
};

describe('RequestFeedback drafting', () => {
  it('returns an ask-which outcome for an ambiguous name instead of silently picking a Karl', async () => {
    const getResourceSharingStatus = vi.fn();
    const result = await draftRequestFeedback({
      recipients: [{ key: 'reviewer', nameOrEmail: 'Karl' }],
      asks: [confirmAsk],
    }, WORKSPACE, {
      findOrgMembers: vi.fn(async (): Promise<OrgDirectoryResult> => ({
        status: 'ambiguous',
        message: '2 members in Design Team match "Karl". Ask which person before continuing.',
        org: ORG,
        members: [
          { memberId: 'karl-one', displayName: 'Karl Jones', email: 'kj@example.test' },
          { memberId: 'karl-two', displayName: 'Karl Smith', email: 'ks@example.test' },
        ],
      })),
      getResourceSharingStatus,
    });

    expect(result).toMatchObject({
      status: 'ambiguousRecipient',
      action: 'askWhichRecipient',
      recipientKey: 'reviewer',
      matches: [
        { memberId: 'karl-one' },
        { memberId: 'karl-two' },
      ],
    });
    expect(result).not.toHaveProperty('draft');
    expect(getResourceSharingStatus).not.toHaveBeenCalled();
  });

  it('keeps no-team and not-in-org outcomes distinct', async () => {
    const input = {
      recipients: [{ key: 'reviewer', nameOrEmail: 'Mo' }],
      asks: [confirmAsk],
    };
    const noTeam = await draftRequestFeedback(input, WORKSPACE, {
      findOrgMembers: vi.fn(async (): Promise<OrgDirectoryResult> => ({
        status: 'noTeam',
        message: 'This workspace has no current organization.',
        org: null,
        members: [],
      })),
      getResourceSharingStatus: vi.fn(),
    });
    const notFound = await draftRequestFeedback(input, WORKSPACE, {
      findOrgMembers: vi.fn(async (): Promise<OrgDirectoryResult> => ({
        status: 'notFound',
        message: 'No addressable member matching "Mo" is in Design Team.',
        org: ORG,
        members: [],
      })),
      getResourceSharingStatus: vi.fn(),
    });

    expect(noTeam).toMatchObject({ status: 'noTeam' });
    expect(notFound).toMatchObject({
      status: 'recipientNotFound',
      nameOrEmail: 'Mo',
    });
  });

  it('rejects unreachable quorum before checking or handing off subjects', async () => {
    const getResourceSharingStatus = vi.fn();
    const result = await draftRequestFeedback({
      recipients: [{ key: 'reviewer', nameOrEmail: 'karl@example.test' }],
      asks: [confirmAsk],
      quorum: { requiredRecipientCount: 2 },
      subjects: [{ kind: 'file', sourceId: 'mockups/a.html' }],
    }, WORKSPACE, {
      findOrgMembers: vi.fn(async () =>
        matched('karl', 'Karl Jones', 'karl@example.test')),
      getResourceSharingStatus,
    });

    expect(result).toMatchObject({
      status: 'invalidDraft',
      errors: [{ code: 'quorumExceedsRecipients' }],
    });
    expect(getResourceSharingStatus).not.toHaveBeenCalled();
  });

  it('returns a resolved per-recipient draft after reads without creating or waiting on a request', async () => {
    const findOrgMembers = vi.fn(async (query: string) =>
      query === 'karl@example.test'
        ? matched('karl', 'Karl Jones', query)
        : matched('dana', 'Dana Lee', query));
    const getResourceSharingStatus = vi.fn(async (
      kind: ResourceSharingResult['kind'],
      sourceId: string,
    ) => sharing(kind, sourceId, false));

    const result = await handleRequestFeedback({
      recipients: [
        { key: 'visuals', nameOrEmail: 'karl@example.test' },
        { key: 'requirements', nameOrEmail: 'dana@example.test' },
      ],
      asks: [
        confirmAsk,
        {
          type: 'editText',
          id: 'requirements-note',
          label: 'Requirements',
          description: 'What requirement should change?',
          initialText: '',
        },
      ],
      assignments: [
        { askId: 'approve', recipientKey: 'visuals' },
        { askId: 'requirements-note', recipientKey: 'requirements' },
      ],
      subjects: [{ kind: 'file', sourceId: 'mockups/a.html', label: 'Direction A' }],
    }, WORKSPACE, { findOrgMembers, getResourceSharingStatus });

    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload).toMatchObject({
      status: 'draftReady',
      message: expect.stringContaining('Nothing has been published or sent'),
      draft: {
        orgId: ORG.orgId,
        recipients: [
          { userId: 'karl', name: 'Karl Jones' },
          { userId: 'dana', name: 'Dana Lee' },
        ],
        assignments: [
          { askId: 'approve', target: { kind: 'user', userId: 'karl' } },
          { askId: 'requirements-note', target: { kind: 'user', userId: 'dana' } },
        ],
        subjects: [{
          shared: false,
          ref: { kind: 'file', sourceId: 'mockups/a.html', projectId: ORG.teamProjectId },
        }],
      },
    });
    expect(payload.draft).not.toHaveProperty('author');
    expect(payload.draft).not.toHaveProperty('lifecycle');
    expect(payload.draft).not.toHaveProperty('responses');
    expect(findOrgMembers).toHaveBeenCalledTimes(2);
    expect(getResourceSharingStatus).toHaveBeenCalledTimes(1);
  });

  it('binds option artifacts and publishes each resource once', async () => {
    const getResourceSharingStatus = vi.fn(async (kind, sourceId) =>
      sharing(kind, sourceId, false));
    const result = await draftRequestFeedback({
      recipients: [{ key: 'reviewer', nameOrEmail: 'karl@example.test' }],
      asks: [{
        type: 'singleSelect',
        id: 'direction',
        label: 'Direction',
        description: 'Which of these should we build?',
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        artifacts: [
          { entryId: 'a', kind: 'file', sourceId: 'mockups/a.html', label: 'Direction A' },
          { entryId: 'b', kind: 'file', sourceId: 'mockups/b.html', label: 'Direction B' },
        ],
      }],
      // Also listed as a subject. Publishing it twice would walk the author
      // through the share dialog twice for one mockup.
      subjects: [{ kind: 'file', sourceId: 'mockups/a.html', label: 'Direction A' }],
    }, WORKSPACE, {
      findOrgMembers: vi.fn(async () => matched('karl', 'Karl Jones', 'karl@example.test')),
      getResourceSharingStatus,
    });

    expect(result).toMatchObject({
      status: 'draftReady',
      draft: {
        asks: [{
          artifacts: [
            { entryId: 'a', label: 'Direction A', ref: { sourceId: 'mockups/a.html' } },
            { entryId: 'b', label: 'Direction B', ref: { sourceId: 'mockups/b.html' } },
          ],
        }],
        // Both mockups are publishable subjects, and the one named twice
        // appears once.
        subjects: [
          { shared: false, ref: { sourceId: 'mockups/a.html' } },
          { shared: false, ref: { sourceId: 'mockups/b.html' } },
        ],
      },
    });
    expect(getResourceSharingStatus).toHaveBeenCalledTimes(2);
  });

  it('refuses artifacts on an ask type that cannot show one', async () => {
    await expect(draftRequestFeedback({
      recipients: [{ key: 'reviewer', nameOrEmail: 'karl@example.test' }],
      asks: [{
        ...confirmAsk,
        artifacts: [{ entryId: 'approve', kind: 'file', sourceId: 'mockups/a.html' }],
      }],
    }, WORKSPACE, {
      findOrgMembers: vi.fn(async () => matched('karl', 'Karl Jones', 'karl@example.test')),
      getResourceSharingStatus: vi.fn(),
    })).rejects.toThrow(/only supported on singleSelect and reorder/);
  });

  it('rejects an artifact bound to an unknown entry before checking sharing', async () => {
    const getResourceSharingStatus = vi.fn();
    const result = await draftRequestFeedback({
      recipients: [{ key: 'reviewer', nameOrEmail: 'karl@example.test' }],
      asks: [{
        type: 'singleSelect',
        id: 'direction',
        label: 'Direction',
        description: 'Which should we build?',
        options: [{ id: 'a', label: 'A' }],
        artifacts: [{ entryId: 'missing', kind: 'file', sourceId: 'mockups/a.html' }],
      }],
    }, WORKSPACE, {
      findOrgMembers: vi.fn(async () => matched('karl', 'Karl Jones', 'karl@example.test')),
      getResourceSharingStatus,
    });

    expect(result).toMatchObject({
      status: 'invalidDraft',
      errors: [{ code: 'unknownArtifactEntry' }],
    });
    expect(getResourceSharingStatus).not.toHaveBeenCalled();
  });
});
