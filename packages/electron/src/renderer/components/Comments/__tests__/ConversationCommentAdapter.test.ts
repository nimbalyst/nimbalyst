import type {
  Actor,
  CommentCapabilities,
  ConversationEvent,
  CreateCommentInput,
} from '@nimbalyst/collab-protocol';
import { MAX_RICH_COMMENT_TEXT_BYTES } from '@nimbalyst/collab-protocol';
import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';

import { createConversationCommentAdapter } from '../ConversationCommentAdapter';

const VIEWER: Actor = {
  kind: 'user',
  userId: 'member-a',
  onBehalfOfUserId: 'member-a',
};

const CAPABILITIES: CommentCapabilities = {
  read: true,
  comment: true,
  react: true,
  editOwn: true,
  deleteOwn: true,
  moderate: false,
  manageRoom: false,
};

function message(
  id: string,
  sequence: number,
  text: string,
  clientMutationId = `mutation-${id}`,
): ConversationEvent {
  return {
    id,
    conversationId: 'conversation-a',
    sequence,
    clientMutationId,
    actor: VIEWER,
    operation: 'messageCreated',
    payload: {
      body: { version: 1, format: 'plainText', text },
      resourceRefs: [],
    },
    createdAt: sequence,
    serverReceivedAt: sequence,
  };
}

function createAdapter(
  invoke: (channel: string, request: any) => Promise<unknown>,
) {
  return createConversationCommentAdapter({
    orgId: 'org-a',
    conversationId: 'conversation-a',
    sourceKind: 'roomMessage',
    viewerActor: VIEWER,
    capabilities: CAPABILITIES,
    pageSize: 2,
    store: createStore(),
    invoke,
    createMutationId: () => 'generated-mutation',
  });
}

describe('ConversationCommentAdapter', () => {
  it('posts a message through the adapter and observes the arriving comment', async () => {
    const appended = message(
      'message-1',
      1,
      'hello from the real adapter',
      'client-post-1',
    );
    const invoke = vi.fn(async (channel: string) => {
      expect(channel).toBe('conversation:append');
      return appended;
    });
    const adapter = createAdapter(invoke);
    const changes = vi.fn();
    adapter.subscribe(changes);
    const input: CreateCommentInput = {
      actor: VIEWER,
      body: appended.payload!.body!,
      clientMutationId: 'client-post-1',
      resourceRefs: [],
    };

    const created = await adapter.create(input);

    expect(created.body.text).toBe('hello from the real adapter');
    expect(changes).toHaveBeenCalledWith({
      type: 'created',
      comment: expect.objectContaining({
        ref: expect.objectContaining({ commentId: 'message-1' }),
        body: expect.objectContaining({
          text: 'hello from the real adapter',
        }),
      }),
    });
    expect(invoke).toHaveBeenCalledWith(
      'conversation:append',
      expect.objectContaining({
        orgId: 'org-a',
        conversationId: 'conversation-a',
        input: expect.objectContaining({
          clientMutationId: 'client-post-1',
          operation: 'messageCreated',
        }),
      }),
    );
  });

  it('rejects an oversized create before it reaches the server', async () => {
    const invoke = vi.fn(async () => message('message-1', 1, 'unused'));
    const adapter = createAdapter(invoke);

    await expect(adapter.create({
      actor: VIEWER,
      body: {
        version: 1,
        format: 'plainText',
        text: 'a'.repeat(MAX_RICH_COMMENT_TEXT_BYTES + 1),
      },
      clientMutationId: 'client-post-oversized',
      resourceRefs: [],
    })).rejects.toThrow(/richBodyTooLarge/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects an invalid edit before it reaches the server', async () => {
    // An edit is an append like any other; skipping validation here would let a
    // body the create path refused in through the back door.
    const invoke = vi.fn(async () => message('message-1', 1, 'unused'));
    const adapter = createAdapter(invoke);

    await expect(adapter.edit(
      {
        orgId: 'org-a',
        sourceKind: 'roomMessage',
        sourceId: 'conversation-a',
        commentId: 'message-1',
      },
      {
        version: 1,
        format: 'plainText',
        text: 'a'.repeat(MAX_RICH_COMMENT_TEXT_BYTES + 1),
      },
    )).rejects.toThrow(/richBodyTooLarge/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects an edit whose entity offsets fall outside the body text', async () => {
    const invoke = vi.fn(async () => message('message-1', 1, 'unused'));
    const adapter = createAdapter(invoke);

    await expect(adapter.edit(
      {
        orgId: 'org-a',
        sourceKind: 'roomMessage',
        sourceId: 'conversation-a',
        commentId: 'message-1',
      },
      {
        version: 1,
        format: 'nimbalystMarkdown',
        text: 'text',
        entities: [{ start: 0, end: 99, kind: 'userMention', userId: 'member-b' }],
      },
    )).rejects.toThrow(/bodyEntityOffsetInvalid/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('pages across the server sequence cursor boundary without discarding it', async () => {
    const invoke = vi.fn(async (channel: string, request: any) => {
      expect(channel).toBe('conversation:list');
      if (request.cursor === undefined) {
        return {
          events: [
            message('message-3', 3, 'three'),
            message('message-4', 4, 'four'),
          ],
          nextCursor: '3',
        };
      }
      expect(request.cursor).toBe('3');
      return {
        events: [
          message('message-1', 1, 'one'),
          message('message-2', 2, 'two'),
        ],
      };
    });
    const adapter = createAdapter(invoke);

    const recent = await adapter.list();
    const earlier = await adapter.list(recent.nextCursor);

    expect(recent.nextCursor).toBe('3');
    expect(recent.comments.map((comment) => comment.body.text)).toEqual([
      'three',
      'four',
    ]);
    expect(earlier.comments.map((comment) => comment.body.text)).toEqual([
      'one',
      'two',
    ]);
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'conversation:list',
      expect.objectContaining({ cursor: '3', pageSize: 2 }),
    );
  });
});
