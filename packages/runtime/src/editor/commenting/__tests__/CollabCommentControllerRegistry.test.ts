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
import { applyUpdate, Doc, encodeStateAsUpdate } from 'yjs';

import {
  CommentStore,
  createComment,
  createThread,
  normalizeCommentActor,
} from '../index';
import { CommentCollabProvider } from '../CommentCollabProvider';
import {
  createCommentSharedMap,
  getCommentAnchorSupport,
  YDocCommentRepository,
} from '../YDocCommentRepository';
import {
  collabCommentAnchorAdapterRegistry,
  collectMarkIds,
  createCollabCommentController,
  createRepositoryCollabCommentController,
} from '../CollabCommentControllerRegistry';
import type { CommentAnchor } from '../types';
import { reanchorOrphanedThreads } from '../reanchorOrphanedThreads';

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
    const { commentStore, controller, onCommitted } = createFixture();
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
    expect(commentStore.getComments()[0]).toMatchObject({
      anchor: {
        kind: 'text-quote',
        exact: 'target',
        prefix: 'Alpha ',
        suffix: ' Omega',
      },
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

  it('keeps legacy and unknown-anchor records lossless in immutable snapshots', () => {
    const legacyComment = createComment(
      'Legacy body',
      'Legacy Author',
      'comment-legacy',
      123,
      false,
    );
    const legacyThread = createThread(
      'legacy quote',
      [legacyComment],
      'thread-legacy',
    );
    const legacyMap = createCommentSharedMap(legacyThread);

    const doc = new Doc();
    doc.getArray('comments').insert(0, [legacyMap]);
    expect(legacyMap.has('anchor')).toBe(false);
    const repository = new YDocCommentRepository(doc);
    expect(JSON.stringify(repository.getSnapshot()[0])).toBe(
      JSON.stringify({
        comments: [
          {
            actor: { kind: 'user', displayName: 'Legacy Author' },
            author: 'Legacy Author',
            content: 'Legacy body',
            deleted: false,
            id: 'comment-legacy',
            timeStamp: 123,
            type: 'comment',
          },
        ],
        id: 'thread-legacy',
        quote: 'legacy quote',
        resolved: false,
        type: 'thread',
      }),
    );

    legacyMap.set('anchor', {
      kind: 'future-canvas-region',
      region: { x: 12, y: 24 },
    });
    const futureThread = repository.getSnapshot()[0];
    expect(futureThread.type).toBe('thread');
    if (futureThread.type !== 'thread') throw new Error('Expected a thread.');
    expect(futureThread.anchor).toEqual({
      kind: 'future-canvas-region',
      region: { x: 12, y: 24 },
    });
    expect(getCommentAnchorSupport(futureThread.anchor)).toBe('unsupported');
    const mounted = createFixture();
    const unregister = mounted.commentStore.registerCollaboration(
      new CommentCollabProvider(doc),
    );
    expect(mounted.controller.list().threads[0]).toMatchObject({
      id: 'thread-legacy',
      anchorState: 'unsupported',
    });
    unregister();
    expect(Object.isFrozen(repository.getSnapshot())).toBe(true);
    expect(Object.isFrozen(futureThread)).toBe(true);
    expect(Object.isFrozen(futureThread.comments)).toBe(true);
    expect(Object.isFrozen(futureThread.anchor)).toBe(true);
    expect(repository.deleteComment('thread-legacy', 'comment-legacy')).toEqual(
      {
        index: 0,
        markedComment: expect.objectContaining({
          id: 'comment-legacy',
          content: '[Deleted Comment]',
          deleted: true,
        }),
      },
    );
    expect(repository.getSnapshot()[0]).toMatchObject({ comments: [] });
    expect(repository.deleteThread('thread-legacy')).toBe(true);
    expect(repository.getSnapshot()).toEqual([]);
    repository.destroy();
  });

  it('creates an entity-anchored thread without coercing it to a text selector', async () => {
    const doc = new Doc();
    const repository = new YDocCommentRepository(doc);
    const documentUri = 'collab://org:org-1:doc:mockup-1';
    const anchor: CommentAnchor = {
      kind: 'entity',
      entityType: 'mockup-pin',
      entityId: 'pin-1',
      labelSnapshot: 'button:Save changes',
    };
    const validated: CommentAnchor[] = [];
    const unregister = collabCommentAnchorAdapterRegistry.register({
      documentUri,
      instanceId: 'mounted-tab',
      isActive: () => true,
      isVisible: () => true,
      adapter: {
        handles: (candidate) => candidate.kind === 'entity',
        getState: (candidate) => {
          validated.push(candidate);
          return 'attached';
        },
        describe: () => 'Pin 1 — Save changes button',
        focus: () => true,
      },
    });
    const controller = createRepositoryCollabCommentController({
      repository,
      documentUri,
      currentUser: { id: 'user-1', name: 'Ada' },
      getCapabilities: () => ({ read: true, comment: true }),
      getMembers: () => [],
      isHydrated: () => true,
      isVisible: () => true,
      now: () => 1_000,
    });
    const actor = controller.createAgentActor({
      sessionId: 'session-1',
      sessionName: 'Mockup agent',
    });
    const base = {
      body: 'Shorten this label.',
      clientMutationId: 'mutation-pin',
    };

    try {
      const created = await controller.createAnchored({ ...base, anchor }, actor);
      expect(created).toMatchObject({ anchor, duplicate: false });
      expect(validated).toContainEqual(anchor);

      // The adapter that validated the target and the repository that stored
      // the thread are the same Y.Doc handle: an independent reader over that
      // doc sees the thread the controller just wrote.
      const reader = new YDocCommentRepository(doc);
      expect(reader.getSnapshot()).toEqual([
        expect.objectContaining({
          anchor,
          id: created.threadId,
          quote: 'Pin 1 — Save changes button',
        }),
      ]);
      reader.destroy();

      await expect(
        controller.createAnchored({ ...base, anchor }, actor),
      ).resolves.toMatchObject({
        anchor,
        duplicate: true,
        threadId: created.threadId,
      });

      // Every other anchor shape fails closed rather than being reshaped.
      await expect(
        controller.createAnchored(
          { ...base, clientMutationId: 'mutation-text', anchor: { exact: 'Save' } },
          actor,
        ),
      ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_MOUNTED' });
      await expect(
        controller.createAnchored(
          {
            ...base,
            clientMutationId: 'mutation-region',
            anchor: { kind: 'region', page: 2 } as never,
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_MOUNTED' });
      await expect(
        controller.createAnchored(
          {
            ...base,
            clientMutationId: 'mutation-partial',
            anchor: { kind: 'entity', entityType: 'mockup-pin' } as never,
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: 'ANCHOR_NOT_FOUND' });
      await expect(
        controller.createAnchored(
          { ...base, clientMutationId: 'mutation-spoofed', anchor },
          { kind: 'user', userId: 'user-1', displayName: 'Ada' },
        ),
      ).rejects.toMatchObject({ code: 'COMMENT_FORBIDDEN' });
      expect(controller.list().threads).toHaveLength(1);
    } finally {
      unregister();
      repository.destroy();
    }
  });

  it('converges entity anchors, replies, and resolve state across two Y.Docs', () => {
    const firstDoc = new Doc();
    const secondDoc = new Doc();
    const first = new YDocCommentRepository(firstDoc);
    const second = new YDocCommentRepository(secondDoc);
    const rootComment = createComment('Review this node.', 'Owner', {
      actor: { kind: 'user', userId: 'owner-1', displayName: 'Owner' },
      clientMutationId: 'mutation-root',
      id: 'comment-root',
      timeStamp: 1,
    });
    first.addThread(
      createThread('Node: Launch plan', [rootComment], 'thread-entity', false, {
        kind: 'entity',
        entityType: 'mindmap-node',
        entityId: 'node-launch',
        field: 'title',
        labelSnapshot: 'Launch plan',
      }),
    );
    applyUpdate(secondDoc, encodeStateAsUpdate(firstDoc));

    const firstUpdates: Uint8Array[] = [];
    const secondUpdates: Uint8Array[] = [];
    firstDoc.on('update', (update) => firstUpdates.push(update));
    secondDoc.on('update', (update) => secondUpdates.push(update));
    const firstChanges = vi.fn();
    const secondChanges = vi.fn();
    first.subscribe(firstChanges);
    second.subscribe(secondChanges);

    first.setThreadResolved('thread-entity', true);
    const reply = createComment(
      'The launch dependency is explicit.',
      'Reviewer',
      {
        actor: {
          kind: 'user',
          userId: 'reviewer-1',
          displayName: 'Reviewer',
        },
        clientMutationId: 'mutation-reply',
        id: 'comment-reply',
        replyToCommentId: 'comment-root',
        timeStamp: 2,
      },
    );
    second.appendReply('thread-entity', reply);

    firstUpdates.forEach((update) => applyUpdate(secondDoc, update));
    secondUpdates.forEach((update) => applyUpdate(firstDoc, update));
    expect(first.getSnapshot()).toEqual(second.getSnapshot());
    const converged = first.getSnapshot()[0];
    expect(converged).toMatchObject({
      type: 'thread',
      resolved: true,
      anchor: {
        kind: 'entity',
        entityType: 'mindmap-node',
        entityId: 'node-launch',
        field: 'title',
        labelSnapshot: 'Launch plan',
      },
      comments: [
        { id: 'comment-root' },
        {
          id: 'comment-reply',
          clientMutationId: 'mutation-reply',
          replyToCommentId: 'comment-root',
          actor: {
            kind: 'user',
            userId: 'reviewer-1',
            displayName: 'Reviewer',
          },
        },
      ],
    });
    expect(second.appendReply('thread-entity', reply).duplicate).toBe(true);
    expect(second.getSnapshot()[0]).toMatchObject({ comments: [{}, {}] });

    const unresolveUpdates: Uint8Array[] = [];
    secondDoc.on('update', (update) => unresolveUpdates.push(update));
    second.setThreadResolved('thread-entity', false);
    unresolveUpdates.forEach((update) => applyUpdate(firstDoc, update));
    expect(first.getSnapshot()[0]).toMatchObject({ resolved: false });
    expect(firstChanges).toHaveBeenCalled();
    expect(secondChanges).toHaveBeenCalled();
    first.destroy();
    second.destroy();
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

  describe('reanchorOrphanedThreads', () => {
    it('re-attaches a thread whose MarkNode was stripped but whose quote survives', () => {
      // The state a markdown round-trip leaves behind (#2644): the thread and
      // the quoted text both survive, but every MarkNode is gone, so the
      // highlight stops rendering and the anchor reports orphaned.
      const { commentStore, controller, editor } = createFixture(
        'Alpha target Omega',
      );
      const thread = createThread(
        'target',
        [createComment('Still relevant?', 'Owner')],
        'thread-orphan',
      );
      commentStore.addComment(thread);
      // Already reported attached: a unique quote is drawn as a decoration
      // even without a MarkNode. Healing restores the MarkNode itself.
      expect(collectMarkIds(editor as LexicalEditor).has('thread-orphan')).toBe(
        false,
      );

      const result = reanchorOrphanedThreads(editor as LexicalEditor, [thread]);

      expect(result.reattached).toEqual(['thread-orphan']);
      expect(collectMarkIds(editor as LexicalEditor).has('thread-orphan')).toBe(
        true,
      );
      expect(controller.list().threads[0].anchorState).toBe('attached');
    });

    it('leaves a thread orphaned when its quote no longer resolves uniquely', () => {
      // Rewritten text (gone) and repeated text (ambiguous) must both be left
      // alone rather than guessed at — a wrong re-anchor syncs permanently.
      const { commentStore, controller, editor } = createFixture(
        'target and target again',
      );
      const gone = createThread('vanished wording', [], 'thread-gone');
      const ambiguous = createThread('target', [], 'thread-ambiguous');
      commentStore.addComment(gone);
      commentStore.addComment(ambiguous);

      const result = reanchorOrphanedThreads(editor as LexicalEditor, [
        gone,
        ambiguous,
      ]);

      expect(result.reattached).toEqual([]);
      expect(result.skipped).toEqual([
        { id: 'thread-gone', reason: 'ANCHOR_NOT_FOUND' },
        { id: 'thread-ambiguous', reason: 'ANCHOR_AMBIGUOUS' },
      ]);
      for (const entry of controller.list().threads) {
        expect(entry.anchorState).toBe('orphaned');
      }
    });

    it('re-attaches by the bare quote when its context changed but the quote is still unique', () => {
      const { commentStore, editor } = createFixture('Changed target Omega');
      const thread = createThread('target', [], 'thread-context', false, {
        kind: 'text-quote',
        exact: 'target',
        prefix: 'Alpha ',
      });
      commentStore.addComment(thread);

      const result = reanchorOrphanedThreads(editor as LexicalEditor, [thread]);

      expect(result.reattached).toEqual(['thread-context']);
    });

    it('never falls back to the bare quote when it repeats', () => {
      const { commentStore, editor } = createFixture('One target and another target');
      const thread = createThread('target', [], 'thread-context-repeat', false, {
        kind: 'text-quote',
        exact: 'target',
        prefix: 'Alpha ',
      });
      commentStore.addComment(thread);

      expect(reanchorOrphanedThreads(editor as LexicalEditor, [thread])).toEqual({
        reattached: [],
        skipped: [{ id: 'thread-context-repeat', reason: 'ANCHOR_AMBIGUOUS' }],
      });
    });
  });
});
