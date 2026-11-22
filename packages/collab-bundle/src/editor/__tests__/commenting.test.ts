// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  deriveCollabEditorCommentsState,
  resolveDocumentCommentCapabilities,
} from '../commenting';

describe('collab editor comments state', () => {
  it('lets a permitted host comment before it has written anything', () => {
    // The regression this guards: `serverAccess` only reaches 'writable' when
    // the server acknowledges a docUpdate, so a reader who opens a document to
    // annotate it and never types stays at 'unknown' for the whole session.
    // Requiring positive write evidence made commenting-without-editing
    // unreachable for every web console user, admins included.
    for (const serverAccess of ['unknown', 'writable', 'not-applicable'] as const) {
      expect(deriveCollabEditorCommentsState({
        connection: 'connected',
        serverAccess,
        hasConnectedOnce: true,
        hostCanComment: true,
      }).capabilities).toEqual({ read: true, comment: true, editBody: true });
    }
  });

  it('refuses when either the host role or the server says no', () => {
    // The host's answer is authoritative in the negative direction: a viewer is
    // refused on a connection the server has said nothing about.
    for (const serverAccess of ['unknown', 'writable', 'not-applicable'] as const) {
      expect(deriveCollabEditorCommentsState({
        connection: 'connected',
        serverAccess,
        hasConnectedOnce: true,
        hostCanComment: false,
      }).capabilities).toEqual({ read: true, comment: false, editBody: true });
    }

    // A server verdict that refuses writes overrides a host that says yes. This
    // is how a stale role projection is withdrawn: the first rejected write
    // moves `serverAccess` off 'unknown' and the affordance disappears.
    for (const serverAccess of ['read-only', 'revoked'] as const) {
      expect(deriveCollabEditorCommentsState({
        connection: 'connected',
        serverAccess,
        hasConnectedOnce: true,
        hostCanComment: true,
      }).capabilities).toEqual({ read: true, comment: false, editBody: false });
    }
  });

  it('hydrates on first connection and stays hydrated across a drop', () => {
    const beforeConnecting = deriveCollabEditorCommentsState({
      connection: 'syncing',
      serverAccess: 'unknown',
      hasConnectedOnce: false,
      hostCanComment: true,
    });
    expect(beforeConnecting.isHydrated).toBe(false);

    const connected = deriveCollabEditorCommentsState({
      connection: 'connected',
      serverAccess: 'unknown',
      hasConnectedOnce: false,
      hostCanComment: true,
    });
    expect(connected).toEqual({
      hasConnectedOnce: true,
      isHydrated: true,
      capabilities: { read: true, comment: true, editBody: true },
    });
    expect(deriveCollabEditorCommentsState({
      connection: 'disconnected',
      serverAccess: 'unknown',
      hasConnectedOnce: connected.hasConnectedOnce,
      hostCanComment: true,
    }).isHydrated).toBe(true);
  });

  it('keeps commenting and locks the body for a commenter, from either side', () => {
    const base = { connection: 'connected' as const, hasConnectedOnce: true };
    // The room's verdict alone: covers a commenter the host roster cannot see.
    expect(deriveCollabEditorCommentsState({
      ...base, serverAccess: 'comment-only', hostCanComment: true,
    }).capabilities).toEqual({ read: true, comment: true, editBody: false });
    // The host's answer alone, before or without a verdict.
    expect(deriveCollabEditorCommentsState({
      ...base, serverAccess: 'writable', hostCanComment: true, hostCanEditBody: false,
    }).capabilities).toEqual({ read: true, comment: true, editBody: false });
    // Neither: unchanged from before the field existed.
    expect(deriveCollabEditorCommentsState({
      ...base, serverAccess: 'writable', hostCanComment: true,
    }).capabilities).toEqual({ read: true, comment: true, editBody: true });
  });
});

describe('document comment access', () => {
  it('grants comment capability without requiring edit access', async () => {
    const canAccess = vi.fn(async (input: { action: 'view' | 'edit' | 'admin' }) => ({
      allowed: input.action === 'view',
    }));

    await expect(resolveDocumentCommentCapabilities(canAccess, {
      orgId: 'org-1',
      projectId: 'project-1',
    })).resolves.toEqual({ read: true, comment: true });
    expect(canAccess).toHaveBeenCalledTimes(1);
    expect(canAccess).toHaveBeenCalledWith({
      orgId: 'org-1',
      projectId: 'project-1',
      action: 'view',
    });
  });
});
