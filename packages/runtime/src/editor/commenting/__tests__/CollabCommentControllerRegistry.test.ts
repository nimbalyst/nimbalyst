// @vitest-environment node
import { MarkNode } from '@lexical/mark';
import { createHeadlessEditor } from '@lexical/headless';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type LexicalEditor,
} from 'lexical';
import { describe, expect, it, vi } from 'vitest';
import { Doc } from 'yjs';

import {
  CommentStore,
  createComment,
  createThread,
  normalizeCommentActor,
} from '../index';
import { CommentCollabProvider } from '../CommentCollabProvider';
import {
  createCollabCommentController,
} from '../CollabCommentControllerRegistry';

function createFixture(
  text = 'Alpha target Omega',
  capabilities = { read: true, comment: true },
  onError: (error: Error) => void = (error) => {
    throw error;
  },
) {
  const editor = createHeadlessEditor({
    namespace: 'collab-comment-controller-test',
    nodes: [MarkNode],
    onError,
  });
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append($createTextNode(text)),
        );
    },
    { discrete: true },
  );

  const commentStore = new CommentStore(editor as LexicalEditor);
  const onCommitted = vi.fn();
  const controller = createCollabCommentController({
    commentStore,
    currentUser: { id: 'owner-1', name: 'Owner' },
    documentTitle: 'Design',
    documentUri: 'collab://org:o:doc:d',
    editor: editor as LexicalEditor,
    getCapabilities: () => capabilities,
    getMembers: () => [
      { userId: 'user-2', name: 'Reviewer' },
    ],
    isHydrated: () => true,
    isVisible: () => true,
    onCommitted,
  });
  return { commentStore, controller, editor, onCommitted };
}

describe('CollabCommentController', () => {
  it('normalizes malformed structured actors to the legacy author safely', () => {
    expect(
      normalizeCommentActor(
        { kind: 'agent', sessionId: 'missing-required-fields' },
        'Legacy Author',
      ),
    ).toEqual({
      kind: 'user',
      displayName: 'Legacy Author',
    });
  });

  it('enforces read and comment capabilities at operation time', async () => {
    const unreadable = createFixture('target', {
      read: false,
      comment: false,
    });
    let readError: unknown;
    try {
      unreadable.controller.list();
    } catch (error) {
      readError = error;
    }
    expect(readError).toMatchObject({ code: 'READ_FORBIDDEN' });

    const readOnly = createFixture('target', {
      read: true,
      comment: false,
    });
    const thread = createThread('target', [], 'thread-read-only');
    readOnly.commentStore.addComment(thread);
    await expect(
      readOnly.controller.reply({
        threadId: thread.id,
        body: 'No write access',
        clientMutationId: 'mutation-read-only',
      }, readOnly.controller.createAgentActor({
        sessionId: 'session-1',
        sessionName: 'Design reviewer',
      })),
    ).rejects.toMatchObject({ code: 'COMMENT_FORBIDDEN' });
  });

  it('creates an exact-text anchor with structured agent attribution', async () => {
    const { controller, onCommitted } = createFixture();
    const actor = controller.createAgentActor({
      sessionId: 'session-1',
      sessionName: 'Design reviewer',
    });

    const result = await controller.createAnchored({
      anchor: {
        exact: 'target',
        prefix: 'Alpha ',
        suffix: ' Omega',
      },
      body: 'This needs a clearer contract.',
      clientMutationId: 'mutation-create-1',
      mentionedUserIds: ['user-2'],
    }, actor);

    expect(result.duplicate).toBe(false);
    expect(result.comment.actor).toEqual({
      kind: 'agent',
      sessionId: 'session-1',
      sessionName: 'Design reviewer',
      onBehalfOfUserId: 'owner-1',
      onBehalfOfDisplayName: 'Owner',
    });
    expect(controller.list().threads[0]).toMatchObject({
      id: result.threadId,
      quote: 'target',
      anchorState: 'attached',
    });
    expect(onCommitted).toHaveBeenCalledWith(
      expect.objectContaining({
        mentionedUserIds: ['user-2'],
        replyRecipientUserIds: [],
      }),
    );
  });

  it('preserves reply targeting and deduplicates retried mutation ids', async () => {
    const { commentStore, controller } = createFixture();
    const rootComment = createComment('Please explain this.', 'Reviewer', {
      actor: {
        kind: 'user',
        userId: 'user-2',
        displayName: 'Reviewer',
      },
    });
    const thread = createThread('target', [rootComment], 'thread-1');
    commentStore.addComment(thread);
    const actor = controller.createAgentActor({
      sessionId: 'session-1',
      sessionName: 'Design reviewer',
    });
    const input = {
      threadId: thread.id,
      replyToCommentId: rootComment.id,
      body: 'The invariant is documented below.',
      clientMutationId: 'mutation-reply-1',
    };

    const first = await controller.reply(input, actor);
    const retry = await controller.reply(input, actor);

    expect(first.duplicate).toBe(false);
    expect(first.comment.replyToCommentId).toBe(rootComment.id);
    expect(retry).toMatchObject({
      duplicate: true,
      threadId: thread.id,
      comment: { id: first.comment.id },
    });
    expect(controller.list().threads[0].comments).toHaveLength(2);
  });

  it('fails ambiguous anchors instead of guessing', async () => {
    const { controller } = createFixture('target and target');
    const actor = controller.createAgentActor({
      sessionId: 'session-1',
      sessionName: 'Design reviewer',
    });

    await expect(
      controller.createAnchored({
        anchor: { exact: 'target' },
        body: 'Which one?',
        clientMutationId: 'mutation-create-ambiguous',
      }, actor),
    ).rejects.toMatchObject({
      code: 'ANCHOR_AMBIGUOUS',
    });
  });

  it('surfaces the specific anchor code even when the editor swallows errors', async () => {
    // A production editor whose onError logs instead of rethrowing must not
    // flatten ANCHOR_AMBIGUOUS into the generic ANCHOR_NOT_FOUND post-check.
    const { controller } = createFixture('target and target', undefined, () => {
      /* swallow, matching an editor whose onError does not rethrow */
    });
    const actor = controller.createAgentActor({
      sessionId: 'session-1',
      sessionName: 'Design reviewer',
    });

    await expect(
      controller.createAnchored({
        anchor: { exact: 'target' },
        body: 'Which one?',
        clientMutationId: 'mutation-swallowed-ambiguous',
      }, actor),
    ).rejects.toMatchObject({
      code: 'ANCHOR_AMBIGUOUS',
    });
    expect(controller.list().threads).toHaveLength(0);
  });

  it('uses prefix and suffix to disambiguate repeated text', async () => {
    const { controller } = createFixture(
      'First target choice. Second target choice.',
    );
    const actor = controller.createAgentActor({
      sessionId: 'session-1',
      sessionName: 'Design reviewer',
    });

    const result = await controller.createAnchored({
      anchor: {
        exact: 'target',
        prefix: 'Second ',
        suffix: ' choice.',
      },
      body: 'This is the intended occurrence.',
      clientMutationId: 'mutation-disambiguated',
    }, actor);

    expect(result.duplicate).toBe(false);
    expect(controller.list().threads[0].anchorState).toBe('attached');
  });

  it('anchors selections spanning formatted text nodes', async () => {
    const { controller, editor } = createFixture();
    editor.update(
      () => {
        const formatted = $createTextNode('target');
        formatted.toggleFormat('bold');
        $getRoot()
          .clear()
          .append(
            $createParagraphNode().append(
              $createTextNode('Alpha '),
              formatted,
              $createTextNode(' Omega'),
            ),
          );
      },
      { discrete: true },
    );
    const actor = controller.createAgentActor({
      sessionId: 'session-1',
      sessionName: 'Design reviewer',
    });

    const result = await controller.createAnchored({
      anchor: { exact: 'ha target Om' },
      body: 'This spans three text nodes.',
      clientMutationId: 'mutation-multi-node',
    }, actor);

    expect(result.duplicate).toBe(false);
    expect(controller.list().threads[0]).toMatchObject({
      quote: 'ha target Om',
      anchorState: 'attached',
    });
  });

  it('rejects reuse of a mutation id with changed input', async () => {
    const { commentStore, controller } = createFixture();
    const thread = createThread('target', [], 'thread-conflict');
    commentStore.addComment(thread);
    const actor = controller.createAgentActor({
      sessionId: 'session-1',
      sessionName: 'Design reviewer',
    });
    await controller.reply({
      threadId: thread.id,
      body: 'Original',
      clientMutationId: 'mutation-conflict',
    }, actor);

    await expect(
      controller.reply({
        threadId: thread.id,
        body: 'Changed',
        clientMutationId: 'mutation-conflict',
      }, actor),
    ).rejects.toMatchObject({ code: 'MUTATION_CONFLICT' });
  });

  it('enforces body and mention bounds before mutating', async () => {
    const { commentStore, controller } = createFixture();
    const thread = createThread('target', [], 'thread-limits');
    commentStore.addComment(thread);
    const actor = controller.createAgentActor({
      sessionId: 'session-1',
      sessionName: 'Design reviewer',
    });

    await expect(
      controller.reply({
        threadId: thread.id,
        body: 'x'.repeat(32 * 1024 + 1),
        clientMutationId: 'mutation-body-limit',
      }, actor),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    await expect(
      controller.reply({
        threadId: thread.id,
        body: 'Bounded reply',
        clientMutationId: 'mutation-mention-limit',
        mentionedUserIds: Array.from(
          { length: 51 },
          (_, index) => `user-${index}`,
        ),
      }, actor),
    ).rejects.toMatchObject({ code: 'MENTION_FORBIDDEN' });
    expect(controller.list().threads[0].comments).toHaveLength(0);
  });

  it('paginates threads and filters resolved entries deterministically', () => {
    const { commentStore, controller } = createFixture();
    commentStore.addComment(createThread('one', [], 'thread-one', false));
    commentStore.addComment(createThread('two', [], 'thread-two', true));
    commentStore.addComment(createThread('three', [], 'thread-three', false));

    const first = controller.list({ includeResolved: false, limit: 1 });
    const second = controller.list({
      includeResolved: false,
      limit: 1,
      cursor: first.nextCursor,
    });

    expect(first.threads.map((thread) => thread.id)).toEqual(['thread-one']);
    expect(first.nextCursor).toBe('1');
    expect(second.threads.map((thread) => thread.id)).toEqual(['thread-three']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('serializes actor, reply, and idempotency metadata into Y.Map records', () => {
    const { commentStore } = createFixture();
    const comment = createComment('Agent reply', 'Design reviewer', {
      actor: {
        kind: 'agent',
        sessionId: 'session-1',
        sessionName: 'Design reviewer',
        onBehalfOfUserId: 'owner-1',
      },
      clientMutationId: 'mutation-y-map',
      replyToCommentId: 'comment-root',
    });

    const shared = commentStore._createCollabSharedMap(comment);
    const doc = new Doc();
    doc.getArray('comments').insert(0, [shared]);

    expect(shared.get('actor')).toEqual(comment.actor);
    expect(shared.get('clientMutationId')).toBe('mutation-y-map');
    expect(shared.get('replyToCommentId')).toBe('comment-root');
  });

  it('materializes an already-hydrated Y.Doc when a headless store attaches', () => {
    const { commentStore } = createFixture();
    const comment = createComment('Canonical reply', 'Design reviewer', {
      actor: {
        kind: 'agent',
        sessionId: 'session-1',
        sessionName: 'Design reviewer',
        onBehalfOfUserId: 'owner-1',
      },
      clientMutationId: 'mutation-hydrated',
      replyToCommentId: 'comment-root',
    });
    const sharedThread = commentStore._createCollabSharedMap(
      createThread('target', [comment], 'thread-hydrated'),
    );
    const doc = new Doc();
    doc.getArray('comments').insert(0, [sharedThread]);

    const target = createFixture().commentStore;
    const unregister = target.registerCollaboration(
      new CommentCollabProvider(doc),
    );

    expect(target.getComments()).toEqual([
      expect.objectContaining({
        id: 'thread-hydrated',
        comments: [
          expect.objectContaining({
            actor: comment.actor,
            clientMutationId: 'mutation-hydrated',
            replyToCommentId: 'comment-root',
          }),
        ],
      }),
    ]);
    unregister();
  });

  it('broadcasts an agent reply through the shared Y.Doc to another store', async () => {
    const source = createFixture();
    const rootComment = createComment('Can you clarify?', 'Reviewer', {
      actor: {
        kind: 'user',
        userId: 'user-2',
        displayName: 'Reviewer',
      },
    });
    const thread = createThread('target', [rootComment], 'thread-shared');
    const doc = new Doc();
    doc.getArray('comments').insert(0, [
      source.commentStore._createCollabSharedMap(thread),
    ]);

    const first = createFixture();
    const second = createFixture();
    const unregisterFirst = first.commentStore.registerCollaboration(
      new CommentCollabProvider(doc),
    );
    const unregisterSecond = second.commentStore.registerCollaboration(
      new CommentCollabProvider(doc),
    );
    const actor = first.controller.createAgentActor({
      sessionId: 'session-1',
      sessionName: 'Design reviewer',
    });

    await first.controller.reply({
      threadId: 'thread-shared',
      replyToCommentId: rootComment.id,
      body: 'Yes—the contract is explicit now.',
      clientMutationId: 'mutation-shared-reply',
    }, actor);

    expect(second.controller.list().threads[0].comments).toHaveLength(2);
    expect(second.controller.list().threads[0].comments[1]).toMatchObject({
      body: 'Yes—the contract is explicit now.',
      actor: {
        kind: 'agent',
        sessionId: 'session-1',
      },
      replyToCommentId: rootComment.id,
    });
    unregisterFirst();
    unregisterSecond();
  });
});
