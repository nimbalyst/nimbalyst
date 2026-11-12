// @vitest-environment node

/**
 * The browser host's comments service for extension editors.
 *
 * These cover the refusals, not the happy path's plumbing: every one of them is
 * a case where the cheap thing to do is let the write through and the expensive
 * thing to discover is a comment that looked shared and was not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import type {
  CommentAnchor,
  CommentCapabilities,
  MountedCommentAnchorAdapter,
} from '@nimbalyst/extension-sdk/types/comments';

import {
  createExtensionCommentsService,
  type HostedExtensionComments,
} from '../extensionComments';

const PIN_ANCHOR: CommentAnchor = {
  kind: 'entity',
  entityType: 'mockup-pin',
  entityId: 'pin-1',
  labelSnapshot: 'button:Save changes',
};

const MEMBERS = [
  { userId: 'member-ada', name: 'Ada' },
  { userId: 'member-bo', name: 'Bo' },
];

const hosted: HostedExtensionComments[] = [];

afterEach(() => {
  for (const entry of hosted.splice(0)) entry.destroy();
});

function attachedAdapter(overrides: Partial<MountedCommentAnchorAdapter> = {}) {
  return {
    handles: (anchor: CommentAnchor) => anchor.kind === 'entity',
    getState: () => 'attached' as const,
    describe: () => 'Pin 1 — Save changes',
    focus: () => true,
    ...overrides,
  };
}

function build(options: {
  capabilities?: CommentCapabilities;
  hydrated?: boolean;
  onMention?: (recipients: string[], payload: { snippet?: string }) => void;
} = {}) {
  const yDoc = new Y.Doc();
  const entry = createExtensionCommentsService({
    yDoc,
    host: {
      currentUser: { id: 'member-ada', name: 'Ada' },
      documentId: 'doc-1',
      documentTitle: 'Sign in.mockup.html',
      documentUri: `nimbalyst://doc/${crypto.randomUUID()}`,
      instanceId: 'mount-1',
      getMembers: () => MEMBERS,
      getCapabilities: () => options.capabilities ?? { read: true, comment: true },
      isHydrated: () => options.hydrated ?? true,
      onMention: options.onMention as never,
    },
  });
  hosted.push(entry);
  return { ...entry, yDoc };
}

const placement = (anchor: CommentAnchor = PIN_ANCHOR) => ({
  anchor,
  content: 'This button is too small',
  clientMutationId: crypto.randomUUID(),
});

describe('the browser comments service for extension editors', () => {
  it('writes a thread into the shared document, quoted by what the editor says the anchor is', async () => {
    const { service, yDoc } = build();
    service.registerAnchorAdapter(attachedAdapter());

    const result = await service.createThread(placement());

    expect(result.duplicate).toBe(false);
    // The quote is the mounted editor's own description, not the anchor's own
    // stale label snapshot: the editor is the only thing looking at the DOM.
    expect(result.thread.quote).toBe('Pin 1 — Save changes');
    expect(result.comment.author).toBe('Ada');
    // In the shared array, so a peer and the codec see the same thread.
    expect(yDoc.getArray('comments').length).toBe(1);
    expect(service.getSnapshot()).toHaveLength(1);
  });

  it('refuses a thread whose anchor no mounted editor reports attached', async () => {
    const { service, yDoc } = build();
    // Nothing registered: the pin this claims to point at may not exist at all.
    await expect(service.createThread(placement())).rejects.toThrow(/not attached/i);

    service.registerAnchorAdapter(attachedAdapter({ getState: () => 'orphaned' }));
    await expect(service.createThread(placement())).rejects.toThrow(/not attached/i);
    expect(yDoc.getArray('comments').length).toBe(0);
  });

  it('refuses to author when the page says this role may not comment', async () => {
    const { service, yDoc } = build({ capabilities: { read: true, comment: false } });
    service.registerAnchorAdapter(attachedAdapter());

    await expect(service.createThread(placement())).rejects.toThrow(/permission/i);
    expect(yDoc.getArray('comments').length).toBe(0);
    // Read-only is not blind: existing threads stay visible.
    expect(service.getCapabilities()).toEqual({ read: true, comment: false });
  });

  it('gives a commenter session read-only, no-comment access on an extension page', async () => {
    const { service, yDoc } = build({ capabilities: { read: true, comment: true, editBody: false } });
    service.registerAnchorAdapter(attachedAdapter());

    expect(service.getCapabilities()).toEqual({ read: true, comment: false, editBody: false });
    await expect(service.createThread(placement())).rejects.toThrow(/permission/i);
    expect(yDoc.getArray('comments').length).toBe(0);
  });

  it('refuses to author before the room has synced once', async () => {
    const { service, yDoc } = build({ hydrated: false });
    service.registerAnchorAdapter(attachedAdapter());

    await expect(service.createThread(placement())).rejects.toThrow(/hydrat/i);
    expect(yDoc.getArray('comments').length).toBe(0);
  });

  it('hides every thread from a reader the page has not granted read access', async () => {
    const { service } = build();
    service.registerAnchorAdapter(attachedAdapter());
    await service.createThread(placement());

    const revoked = build({ capabilities: { read: false, comment: true } });
    // `comment` is ANDed with `read`: a page cannot produce a composer over
    // threads its user is not allowed to see.
    expect(revoked.service.getCapabilities()).toEqual({ read: false, comment: false });
    expect(revoked.service.getSnapshot()).toHaveLength(0);
    expect(revoked.service.getMentionableMembers()).toHaveLength(0);
  });

  it('notifies mentions without addressing the author, and offers only other members', async () => {
    const onMention = vi.fn();
    const { service } = build({ onMention });
    service.registerAnchorAdapter(attachedAdapter());

    expect(service.getMentionableMembers().map((member) => member.userId))
      .toEqual(['member-bo']);

    await service.createThread({ ...placement(), mentionedUserIds: ['member-ada', 'member-bo'] });

    expect(onMention).toHaveBeenCalledTimes(1);
    expect(onMention.mock.calls[0]?.[0]).toEqual(['member-bo']);
  });

  it('does not publish a panel it has no surface for', () => {
    const { service } = build();
    // A method that silently did nothing would be found by a user, not a test.
    expect('openPanel' in service).toBe(false);
  });

  it('stops answering once the mount is torn down', async () => {
    const entry = build();
    entry.service.registerAnchorAdapter(attachedAdapter());
    entry.destroy();

    expect(entry.service.getCapabilities()).toEqual({ read: false, comment: false });
    await expect(entry.service.createThread(placement())).rejects.toThrow(/no longer mounted/i);
  });
});
