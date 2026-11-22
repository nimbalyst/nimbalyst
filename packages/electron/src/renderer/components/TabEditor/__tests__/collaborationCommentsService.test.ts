// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Doc } from 'yjs';

import {
  collabCommentAnchorAdapterRegistry,
  collabCommentControllerRegistry,
} from '@nimbalyst/runtime/editor/commenting/CollabCommentControllerRegistry';
import type {
  CommentCapabilities,
  MountedCommentAnchorAdapter,
} from '@nimbalyst/extension-sdk';

import {
  createHostedCollaborationComments,
  type CollaborationCommentsHostConfig,
  type HostedCollaborationComments,
} from '../collaborationCommentsService';

type Fixture = {
  active: { value: boolean };
  capabilities: { value: CommentCapabilities };
  hosted: HostedCollaborationComments;
  host: CollaborationCommentsHostConfig;
  hydrated: { value: boolean };
  visible: { value: boolean };
};

function createFixture(
  input: {
    document?: Doc;
    instanceId?: string;
    active?: boolean;
    visible?: boolean;
    now?: number;
  } = {}
): Fixture {
  const active = { value: input.active ?? true };
  const visible = { value: input.visible ?? true };
  const hydrated = { value: true };
  const capabilities = {
    value: { read: true, comment: true },
  };
  const host: CollaborationCommentsHostConfig = {
    currentUser: { id: 'member-host', name: 'Host User' },
    documentId: 'doc-comments',
    documentTitle: 'Launch plan',
    documentUri: 'collab://org:team:doc:doc-comments',
    instanceId: input.instanceId ?? 'tab-one',
    getMembers: () => [
      { userId: 'member-host', name: 'Host User' },
      { userId: 'member-reviewer', name: 'Reviewer' },
    ],
    isActive: () => active.value,
    isVisible: () => visible.value,
    isHydrated: () => hydrated.value,
    resolveCapabilities: vi.fn(async () => capabilities.value),
    now: () => input.now ?? 42,
    onMention: vi.fn(),
    onReply: vi.fn(),
  };
  return {
    active,
    capabilities,
    host,
    hosted: createHostedCollaborationComments({
      yDoc: input.document ?? new Doc(),
      host,
    }),
    hydrated,
    visible,
  };
}

function entityAdapter(
  input: {
    state?: { value: 'attached' | 'orphaned' };
    focus?: MountedCommentAnchorAdapter['focus'];
    description?: string;
  } = {}
): MountedCommentAnchorAdapter {
  return {
    handles: (anchor) => anchor.kind === 'entity',
    getState: () => input.state?.value ?? 'attached',
    describe: () => input.description ?? 'Node: Launch',
    focus: input.focus ?? vi.fn(() => true),
  };
}

afterEach(() => {
  collabCommentControllerRegistry.clear();
  collabCommentAnchorAdapterRegistry.clear();
});

describe('hosted extension comments', () => {
  it('omits openPanel when the host has no real comments panel surface', () => {
    const fixture = createFixture();

    expect(fixture.hosted.service).not.toHaveProperty('openPanel');

    fixture.hosted.destroy();
  });

  it('carries a locked body to the extension when the host re-resolves after a verdict', async () => {
    const fixture = createFixture();
    await fixture.hosted.refreshCapabilities();
    expect(fixture.hosted.service.getCapabilities()).toEqual({ read: true, comment: true });

    // The room's verdict says comment-only; on an extension page the host
    // answers read-only, no-comment.
    fixture.capabilities.value = { read: true, comment: false, editBody: false };
    const listener = vi.fn();
    fixture.hosted.service.subscribe(listener);
    await fixture.hosted.refreshCapabilities();
    expect(fixture.hosted.service.getCapabilities()).toEqual({ read: true, comment: false, editBody: false });
    expect(listener).toHaveBeenCalled();
    fixture.hosted.destroy();
  });

  it('keeps authority host-owned and re-reads access, hydration, and roster at mutation time', async () => {
    const fixture = createFixture({ now: 1_234 });
    fixture.hosted.service.registerAnchorAdapter(entityAdapter());

    await expect(
      fixture.hosted.service.createThread({
        anchor: {
          kind: 'entity',
          entityType: 'mindmap-node',
          entityId: 'node-1',
        },
        content: 'Untrusted mention',
        clientMutationId: 'mutation-outsider',
        mentionedUserIds: ['member-outsider'],
      })
    ).rejects.toMatchObject({ code: 'MENTION_FORBIDDEN' });
    expect(fixture.hosted.service.getSnapshot()).toHaveLength(0);

    const created = await fixture.hosted.service.createThread({
      anchor: {
        kind: 'entity',
        entityType: 'mindmap-node',
        entityId: 'node-1',
        labelSnapshot: 'Launch',
      },
      content: 'Review this node.',
      clientMutationId: 'mutation-create',
      mentionedUserIds: ['member-reviewer'],
      actor: {
        kind: 'user',
        userId: 'spoofed-user',
        displayName: 'Spoofed User',
      },
      currentUser: { id: 'spoofed-user', name: 'Spoofed User' },
      timeStamp: 9_999,
      capabilities: { read: true, comment: true },
      documentId: 'spoofed-document',
      notificationSender: vi.fn(),
    } as never);

    expect(created.comment).toMatchObject({
      actor: {
        kind: 'user',
        userId: 'member-host',
        displayName: 'Host User',
      },
      author: 'Host User',
      content: 'Review this node.',
      timeStamp: 1_234,
    });
    expect(created.comment).not.toHaveProperty('currentUser');
    expect(fixture.host.onMention).toHaveBeenCalledWith(
      ['member-reviewer'],
      expect.objectContaining({
        commentId: created.comment.id,
        threadId: created.thread.id,
      })
    );

    fixture.capabilities.value = { read: true, comment: false };
    await expect(
      fixture.hosted.service.reply({
        threadId: created.thread.id,
        content: 'Downgrade must win.',
        clientMutationId: 'mutation-after-downgrade',
      })
    ).rejects.toMatchObject({ code: 'COMMENT_FORBIDDEN' });
    expect(created.thread.comments).toHaveLength(1);
    expect(fixture.host.resolveCapabilities).toHaveBeenCalledTimes(4);

    fixture.capabilities.value = { read: true, comment: true };
    fixture.hydrated.value = false;
    await expect(
      fixture.hosted.service.setResolved(created.thread.id, true)
    ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_HYDRATED' });
    fixture.hosted.destroy();
  });

  it('selects the active mounted adapter and removes stale adapters and controllers on remount', async () => {
    const document = new Doc();
    const first = createFixture({
      document,
      instanceId: 'tab-first',
      active: false,
      visible: true,
    });
    const second = createFixture({
      document,
      instanceId: 'tab-second',
      active: true,
      visible: true,
    });
    const firstFocus = vi.fn(() => true);
    const secondFocus = vi.fn(() => true);
    first.hosted.service.registerAnchorAdapter(
      entityAdapter({ focus: firstFocus, description: 'First node' })
    );
    const secondState = { value: 'attached' as const } as {
      value: 'attached' | 'orphaned';
    };
    second.hosted.service.registerAnchorAdapter(
      entityAdapter({
        state: secondState,
        focus: secondFocus,
        description: 'Active node',
      })
    );

    const created = await first.hosted.service.createThread({
      anchor: {
        kind: 'entity',
        entityType: 'mindmap-node',
        entityId: 'node-active',
      },
      content: 'Focus the active instance.',
      clientMutationId: 'mutation-focus',
    });
    await expect(
      first.hosted.service.focusThread(created.thread.id)
    ).resolves.toBe(true);
    expect(secondFocus).toHaveBeenCalledTimes(1);
    expect(firstFocus).not.toHaveBeenCalled();
    expect(collabCommentControllerRegistry.get(first.host.documentUri)).toBe(
      second.hosted.controller
    );

    secondState.value = 'orphaned';
    await expect(
      first.hosted.service.focusThread(created.thread.id)
    ).resolves.toBe(false);
    expect(secondFocus).toHaveBeenCalledTimes(1);
    second.hosted.destroy();
    expect(
      collabCommentAnchorAdapterRegistry.hasInstance(
        first.host.documentUri,
        'tab-second'
      )
    ).toBe(false);
    expect(collabCommentControllerRegistry.get(first.host.documentUri)).toBe(
      first.hosted.controller
    );

    const remounted = createFixture({
      document,
      instanceId: 'tab-first',
      active: true,
      visible: true,
    });
    const remountedFocus = vi.fn(() => true);
    remounted.hosted.service.registerAnchorAdapter(
      entityAdapter({ focus: remountedFocus })
    );
    expect(collabCommentControllerRegistry.get(first.host.documentUri)).toBe(
      remounted.hosted.controller
    );
    // React can construct the replacement context before the prior effect's
    // cleanup runs. The stale cleanup must not delete the replacement token.
    first.hosted.destroy();
    expect(collabCommentControllerRegistry.get(first.host.documentUri)).toBe(
      remounted.hosted.controller
    );
    await expect(
      remounted.hosted.service.focusThread(created.thread.id)
    ).resolves.toBe(true);
    expect(remountedFocus).toHaveBeenCalledTimes(1);
    expect(firstFocus).not.toHaveBeenCalled();
    remounted.hosted.destroy();
    expect(collabCommentControllerRegistry.has(first.host.documentUri)).toBe(
      false
    );
  });
});
