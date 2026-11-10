// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  COMMENTER_BODY_COMMENT_CAPABILITIES,
  OPEN_BODY_COMMENT_CAPABILITIES,
  bodyCommentCapabilitiesWithVerdict,
  commentRefusalPlan,
  extensionCommentCapabilities,
  resolveTeamBodyCommentCapabilities,
  type TeamBodyAccessCheck,
} from '../teamBodyCommentCapabilities';

function accessAs(projectRole: string | null, allowed = true): TeamBodyAccessCheck {
  return vi.fn(async () => ({ allowed, projectRole }));
}

describe('resolveTeamBodyCommentCapabilities', () => {
  it('puts a project-commenter in commenter mode: comments yes, body no', async () => {
    const canAccess = accessAs('project-commenter');
    await expect(resolveTeamBodyCommentCapabilities(canAccess, { orgId: 'o', projectId: 'p' }))
      .resolves.toEqual({ read: true, comment: true, editBody: false });
    expect(canAccess).toHaveBeenCalledWith({ orgId: 'o', projectId: 'p', action: 'view' });
  });

  it('keeps every other outcome open so a stale projection never locks an editor out', async () => {
    const open = { read: true, comment: true };
    for (const role of ['project-admin', 'project-editor', 'project-viewer', null]) {
      await expect(resolveTeamBodyCommentCapabilities(accessAs(role), { orgId: 'o', projectId: 'p' }))
        .resolves.toEqual(open);
    }
    // Denied (no roster yet, db not ready) is not evidence of commenter.
    await expect(resolveTeamBodyCommentCapabilities(accessAs('project-commenter', false), { orgId: 'o', projectId: 'p' }))
      .resolves.toEqual(open);
    const failing: TeamBodyAccessCheck = vi.fn(async () => { throw new Error('ipc down'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(resolveTeamBodyCommentCapabilities(failing, { orgId: 'o', projectId: 'p' }))
      .resolves.toEqual(open);
    warn.mockRestore();
  });

  it('does not ask for org-level content, which has no project role', async () => {
    const canAccess = accessAs('project-commenter');
    await expect(resolveTeamBodyCommentCapabilities(canAccess, { orgId: 'o', projectId: null }))
      .resolves.toEqual({ read: true, comment: true });
    expect(canAccess).not.toHaveBeenCalled();
  });
});

describe('bodyCommentCapabilitiesWithVerdict', () => {
  it('lets the room verdict override a stale projection in both directions', () => {
    // Projection says editor (or has no roster yet); the room says commenter.
    expect(bodyCommentCapabilitiesWithVerdict(OPEN_BODY_COMMENT_CAPABILITIES, { canWrite: false, canComment: true }))
      .toEqual({ read: true, comment: true, editBody: false });
    // Projection says commenter; the room says this connection may write.
    expect(bodyCommentCapabilitiesWithVerdict(COMMENTER_BODY_COMMENT_CAPABILITIES, { canWrite: true, canComment: true }))
      .toEqual({ read: true, comment: true });
  });

  it('reads a non-writer without the comment tier as read-only, and keeps the projection until a verdict', () => {
    for (const canComment of [false, null]) {
      expect(bodyCommentCapabilitiesWithVerdict(OPEN_BODY_COMMENT_CAPABILITIES, { canWrite: false, canComment }))
        .toEqual({ read: true, comment: false, editBody: false });
    }
    expect(bodyCommentCapabilitiesWithVerdict(COMMENTER_BODY_COMMENT_CAPABILITIES, null))
      .toBe(COMMENTER_BODY_COMMENT_CAPABILITIES);
  });
});

describe('commentRefusalPlan', () => {
  it('reloads twice, then stops', () => {
    expect([0, 1, 2, 3].map(commentRefusalPlan)).toEqual(['reload', 'reload', 'stop', 'stop']);
  });
});

describe('extensionCommentCapabilities', () => {
  it('gives a commenter read-only, no-comment access on an extension page', () => {
    const base = { read: true, comment: true };
    expect(extensionCommentCapabilities(base, COMMENTER_BODY_COMMENT_CAPABILITIES))
      .toEqual({ read: true, comment: false, editBody: false });
    expect(extensionCommentCapabilities(base, OPEN_BODY_COMMENT_CAPABILITIES))
      .toEqual({ read: true, comment: true });
  });
});
