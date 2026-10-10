// @vitest-environment node
/**
 * Headless markdown edits produce a MINIMAL delta.
 *
 * This is the whole reason the markdown path reconciles through the editor
 * instead of taking the codec's cheap `clear + reparse`. A wholesale
 * replacement still ends up with the right text, so asserting on the resulting
 * document cannot tell the two apart -- and the difference is exactly what
 * decides whether a remote collaborator's in-flight edit survives and whether
 * comment anchors stay attached.
 *
 * So these assert on the Yjs UPDATE, not the result. The control case below
 * runs the same assertion against the wipe-and-reseed path and expects the
 * opposite, so a regression cannot pass by making the assertion vacuous.
 */
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { MarkdownCollabContentAdapter } from '@nimbalyst/runtime/sync/MarkdownCollabContentAdapter';
import { $isEmbeddedFileNode, $createEmbeddedFileNode } from '@nimbalyst/runtime/editor/plugins/EmbedPlugin/EmbeddedFileNodeCore';
import { $wrapSelectionInMarkNode } from '@lexical/mark';
import {
  $createRangeSelection,
  $getRoot,
  $isElementNode,
  $setSelection,
  type LexicalNode,
} from 'lexical';
import { HeadlessBodyNodes } from '@nimbalyst/runtime/editor/nodes/headlessBodyNodes';
import { withHeadlessLexicalBridge } from '@nimbalyst/runtime/sync/withHeadlessLexicalBridge';
import type { HeadlessLexicalYDoc } from '@nimbalyst/runtime/sync/HeadlessLexicalYDoc';
import {
  CommentStore,
  createComment,
  createThread,
} from '@nimbalyst/runtime/editor/commenting';
import { CommentCollabProvider } from '@nimbalyst/runtime/editor/commenting/CommentCollabProvider';
import { createCollabCommentController } from '@nimbalyst/runtime/editor/commenting/CollabCommentControllerRegistry';
import { $approveDiffs } from '@nimbalyst/runtime/editor/plugins/DiffPlugin/core/diffPluginUtils';
import {
  $getDiffState,
  $getOriginalMarkdown,
} from '@nimbalyst/runtime/editor/plugins/DiffPlugin/core/DiffState';

import { applyMarkdownReplacementsToYDoc } from '../headlessMarkdownEdit';

const UNTOUCHED = 'Paragraph three is a bystander and must not be rewritten.';
const ORIGINAL = [
  '# Heading',
  '',
  'Paragraph one mentions alpha.',
  '',
  'Paragraph two mentions beta.',
  '',
  UNTOUCHED,
  '',
].join('\n');

/** Yjs stores inserted strings verbatim in the update, so a byte scan works. */
function deltaText(doc: Y.Doc, sinceStateVector: Uint8Array): string {
  return new TextDecoder('latin1').decode(
    Y.encodeStateAsUpdate(doc, sinceStateVector)
  );
}

function seeded(): Y.Doc {
  const doc = new Y.Doc();
  MarkdownCollabContentAdapter.seedFromFile(doc, ORIGINAL);
  return doc;
}

describe('applyMarkdownReplacementsToYDoc', () => {
  it('preserves malformed named-view fences as editable source rather than dropping them', () => {
    const doc = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(doc, '```page-view\n{"id":"broken"}\n```\n\nKeep this prose.');
    const result = MarkdownCollabContentAdapter.exportToFile(doc) as string;
    expect(result).toContain('{"id":"broken"}');
    expect(result).toContain('Keep this prose.');
  });
  it('keeps named views in the document and merges their independent settings', () => {
    const doc = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(doc, '```page-view\n' + JSON.stringify({ id: 'v1', name: 'Open tasks', type: 'task', attrs: { cols: 'title', custom: 'keep' } }) + '\n```\n\nKeep this prose.');
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    for (const [target, patch] of [[doc, { sort: 'title:asc' }], [peer, { cols: 'title,status' }]] as const) {
      withHeadlessLexicalBridge(target, { nodes: HeadlessBodyNodes }, bridge => bridge.editor.update(() => {
        const view = $getRoot().getFirstChild();
        if (!$isEmbeddedFileNode(view)) throw new Error('Expected a named view with independently mergeable settings');
        view.patchViewAttrs(patch);
      }, { discrete: true }));
    }
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const result = MarkdownCollabContentAdapter.exportToFile(doc) as string;
    expect(result).toContain('```page-view');
    expect(result).toContain('"sort":"title:asc"');
    expect(result).toContain('"cols":"title,status"');
    expect(result).toContain('"custom":"keep"');
    expect(result).toContain('Keep this prose.');
    expect(MarkdownCollabContentAdapter.exportToFile(peer)).toBe(result);
  });
  it('merges different placed-view settings edited concurrently on two clients', () => {
    const doc = new Y.Doc();
    withHeadlessLexicalBridge(doc, { nodes: HeadlessBodyNodes }, bridge => bridge.editor.update(() => {
      $getRoot().append($createEmbeddedFileNode({ src: 'https://console.nimbalyst.com/app/view/type/task', label: 'Tasks', attrs: { cols: 'title', custom: 'keep' } }));
    }, { discrete: true }));
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const change = (target: Y.Doc, patch: Record<string, string>) => withHeadlessLexicalBridge(target, { nodes: HeadlessBodyNodes }, bridge => {
      bridge.editor.update(() => {
        const node = $getRoot().getFirstChild();
        if (!$isEmbeddedFileNode(node)) throw new Error('Expected placed view');
        node.patchViewAttrs(patch);
      }, { discrete: true });
    });
    change(doc, { sort: 'title:asc' });
    change(peer, { cols: 'title,status' });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const result = MarkdownCollabContentAdapter.exportToFile(doc) as string;
    expect(result).toContain('sort=title:asc');
    expect(result).toContain('cols=title,status');
    expect(result).toContain('custom=keep');
    expect(MarkdownCollabContentAdapter.exportToFile(peer)).toBe(result);
  });

  it.each([[2, 0, 1], [1, 2, 0], [2, 1, 0], [1, 0, 2], [0, 2, 1]].map((order) => ({ order })))('keeps table/list order $order and concurrent human text in one edit', ({ order }) => {
    const doc = new Y.Doc();
    const table = '| Area | Purpose |\n| --- | --- |\n| Product | What we build |\n| Design | How it works |\n| Archive | Earlier work |';
    const tableRows = table.split('\n');
    const reorderedTable = [...tableRows.slice(0, 2), ...order.map((index) => tableRows[index + 2])].join('\n');
    const list = '- Read the overview\n- Find the decision\n- Open the initiative';
    const reorderedList = order.map((index) => list.split('\n')[index]).join('\n');
    MarkdownCollabContentAdapter.seedFromFile(doc, `# Home\n\n${table}\n\n## Start here\n\n${list}\n\n${UNTOUCHED}\n`);
    // Use the same exported representation an agent gets from readCollabDoc.
    const before = MarkdownCollabContentAdapter.exportToFile(doc) as string;
    const exportedTable = before.slice(before.indexOf('|'), before.indexOf('\n\n## Start here'));
    const exportedList = before.slice(before.indexOf('- Read'), before.indexOf(`\n\n${UNTOUCHED}`));
    const expected = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(expected, before.replace(exportedTable, reorderedTable).replace(exportedList, reorderedList));
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    applyMarkdownReplacementsToYDoc(peer, [{ oldText: UNTOUCHED, newText: `${UNTOUCHED} A human added this concurrently.` }]);
    const vector = Y.encodeStateVector(doc);

    applyMarkdownReplacementsToYDoc(doc, [
      { oldText: exportedTable, newText: reorderedTable },
      { oldText: exportedList, newText: reorderedList },
    ]);

    expect(MarkdownCollabContentAdapter.exportToFile(doc)).toBe(MarkdownCollabContentAdapter.exportToFile(expected));
    expect(deltaText(doc, vector)).not.toContain(UNTOUCHED);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    expect(MarkdownCollabContentAdapter.exportToFile(doc)).toBe(
      (MarkdownCollabContentAdapter.exportToFile(expected) as string).replace(UNTOUCHED, `${UNTOUCHED} A human added this concurrently.`),
    );
    expect(MarkdownCollabContentAdapter.exportToFile(peer)).toBe(MarkdownCollabContentAdapter.exportToFile(doc));
  });

  it('applies the replacement to the document', () => {
    const doc = seeded();

    applyMarkdownReplacementsToYDoc(doc, [
      { oldText: 'beta', newText: 'BETA' },
    ]);

    const result = MarkdownCollabContentAdapter.exportToFile(doc) as string;
    expect(result).toContain('Paragraph two mentions BETA.');
    expect(result).toContain(UNTOUCHED);
  });

  /**
   * A shared document takes an agent edit as final text. Pending red/green
   * nodes written into the room would show both versions to every
   * collaborator, with only the requester able to resolve them.
   */
  it('leaves no pending diff nodes in the shared document', () => {
    const doc = seeded();

    applyMarkdownReplacementsToYDoc(doc, [
      { oldText: 'Paragraph two mentions beta.', newText: 'Paragraph two mentions gamma.' },
    ]);

    const states = withHeadlessLexicalBridge(doc, { nodes: HeadlessBodyNodes }, (headless) =>
      headless.editor.getEditorState().read(() => {
        const found: string[] = [];
        const visit = (node: LexicalNode) => {
          const state = $getDiffState(node);
          if (state) found.push(state);
          if ($isElementNode(node)) node.getChildren().forEach(visit);
        };
        $getRoot().getChildren().forEach(visit);
        return found;
      })
    );
    expect(states).toEqual([]);
    const result = MarkdownCollabContentAdapter.exportToFile(doc) as string;
    expect(result).toContain('Paragraph two mentions gamma.');
    expect(result).not.toContain('mentions beta');
  });

  it('does not rewrite paragraphs it did not touch', () => {
    const doc = seeded();
    const before = Y.encodeStateVector(doc);

    applyMarkdownReplacementsToYDoc(doc, [
      { oldText: 'beta', newText: 'BETA' },
    ]);

    expect(deltaText(doc, before)).not.toContain(UNTOUCHED);
  });

  /**
   * Control. `applyFromFile` is the codec's clear-and-reseed, the path this
   * design deliberately avoids for markdown. If it ever stops re-inserting the
   * untouched paragraph, the assertion above has stopped proving anything.
   */
  it('control: the codec clear-and-reseed DOES rewrite untouched paragraphs', () => {
    const doc = seeded();
    const before = Y.encodeStateVector(doc);

    MarkdownCollabContentAdapter.applyFromFile(
      doc,
      ORIGINAL.replace('beta', 'BETA')
    );

    expect(deltaText(doc, before)).toContain(UNTOUCHED);
  });

  /**
   * The node set is the whole ballgame for this path, and the fixture above
   * cannot catch a gap in it: plain paragraphs need almost no nodes registered.
   *
   * With `EditorNodes` (which omits list/link/image -- a mounted editor gets
   * those from the extension graph, and a standalone headless editor does NOT)
   * the binding threw "Node list is not registered", the editor state came up
   * EMPTY, and the edit then failed as `Old text "..." not found`. That message
   * blames the agent's quote for a document that never loaded, so the real
   * cause is invisible from the tool result.
   */
  it.each([
    ['a bullet list', '# Title\n\n- one\n- two\n\nParagraph mentions alpha.\n'],
    [
      'a link',
      '# Title\n\nSee [docs](https://example.com).\n\nParagraph mentions alpha.\n',
    ],
  ])('edits a document containing %s', (_label, markdown) => {
    const doc = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(doc, markdown);

    applyMarkdownReplacementsToYDoc(doc, [
      { oldText: 'alpha', newText: 'ALPHA' },
    ]);

    expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain('ALPHA');
  });

  it('throws rather than guessing when the text to replace is absent', () => {
    const doc = seeded();

    expect(() =>
      applyMarkdownReplacementsToYDoc(doc, [
        { oldText: 'text that was never in this document', newText: 'x' },
      ])
    ).toThrow();
    expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(UNTOUCHED);
  });

  /**
   * The case above only exercises prose. A LIST-shaped `oldText` takes a
   * different branch: on a failed match the mounted editor reconstructs a
   * target markdown by locating the first list in the document and replacing
   * it, then reports success. Here that silently deleted the shipping blockers
   * -- a list the agent never referred to -- and acknowledged the write to
   * every collaborator.
   */
  it('does not rewrite a different list when a list-shaped match fails', () => {
    const doc = new Y.Doc();
    MarkdownCollabContentAdapter.seedFromFile(
      doc,
      [
        '# Release checklist',
        '',
        '## Shipping blockers',
        '',
        '- audit the key rotation',
        '- verify the backup restore',
        '',
        '## Nice to have',
        '',
        '- tidy the settings icons',
        '- rename the export button',
        '',
      ].join('\n')
    );

    expect(() =>
      applyMarkdownReplacementsToYDoc(doc, [
        {
          // The "Nice to have" list, quoted imperfectly.
          oldText: '- tidy the settings icons\n- rename the export buttons',
          newText: '- tidy the settings icons',
        },
      ])
    ).toThrow();

    const after = MarkdownCollabContentAdapter.exportToFile(doc) as string;
    expect(after).toContain('audit the key rotation');
    expect(after).toContain('verify the backup restore');
  });
});

const COMMENT_QUOTE = 'mentions beta';
const COMMENT_THREAD = 'thread-before-headless-edit';
const DECISION = [
  '```decision',
  'id: dcn-headless-anchor',
  'ask: Approve the current layout?',
  'type: confirm',
  '```',
].join('\n');

/** Reopen the real Lexical/Yjs bridge each time: no retained editor can hide anchor loss. */
function withCommentEditor<T>(
  doc: Y.Doc,
  fn: (context: {
    headless: HeadlessLexicalYDoc;
    store: CommentStore;
    controller: ReturnType<typeof createCollabCommentController>;
  }) => T
): T {
  return withHeadlessLexicalBridge(
    doc,
    { nodes: HeadlessBodyNodes },
    (headless) => {
      const store = new CommentStore(headless.editor);
      const detach = store.registerCollaboration(
        new CommentCollabProvider(doc)
      );
      const controller = createCollabCommentController({
        commentStore: store,
        editor: headless.editor,
        currentUser: { id: 'reviewer', name: 'Reviewer' },
        documentUri: 'collab://org:anchor-proof:doc:headless',
        getCapabilities: () => ({ read: true, comment: true }),
        getMembers: () => [],
        isHydrated: () => true,
        isVisible: () => false,
      });
      try {
        return fn({ headless, store, controller });
      } finally {
        detach();
      }
    }
  );
}

function commentedDecisionDoc(): Y.Doc {
  const doc = new Y.Doc();
  MarkdownCollabContentAdapter.seedFromFile(doc, `${ORIGINAL}\n${DECISION}\n`);
  withCommentEditor(doc, ({ headless, store }) => {
    headless.applyUpdate(() => {
      const text = $getRoot()
        .getAllTextNodes()
        .find((node) => node.getTextContent().includes(COMMENT_QUOTE));
      if (!text) throw new Error('Comment fixture quote missing');
      const start = text.getTextContent().indexOf(COMMENT_QUOTE);
      const selection = $createRangeSelection();
      selection.anchor.set(text.getKey(), start, 'text');
      selection.focus.set(text.getKey(), start + COMMENT_QUOTE.length, 'text');
      $setSelection(selection);
      $wrapSelectionInMarkNode(selection, false, COMMENT_THREAD);
      $setSelection(null);
    });
    store.addComment(
      createThread(
        COMMENT_QUOTE,
        [createComment('Keep this constraint in the decision.', 'Reviewer')],
        COMMENT_THREAD
      )
    );
  });
  return doc;
}

function readCommentAttachment(doc: Y.Doc) {
  return withCommentEditor(doc, ({ controller, headless }) => ({
    threads: controller.list().threads,
    decisionTypes: headless.editor.getEditorState().read(() =>
      $getRoot()
        .getChildren()
        .filter((node) => node.getType() === 'decision')
        .map((node) => node.getType())
    ),
  }));
}

describe('headless edit comment attachment through the Lexical/Yjs bridge', () => {
  it('keeps the actual MarkNode thread attached through prose edits beside a decision, then fresh-client hydration', () => {
    const doc = commentedDecisionDoc();
    const initial = readCommentAttachment(doc);
    expect(initial.decisionTypes).toEqual(['decision']);
    expect(initial.threads).toMatchObject([
      {
        id: COMMENT_THREAD,
        quote: COMMENT_QUOTE,
        anchorState: 'attached',
        comments: [{ body: 'Keep this constraint in the decision.' }],
      },
    ]);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(peer);
    try {
      applyMarkdownReplacementsToYDoc(doc, [
        {
          oldText: 'Paragraph two mentions beta.',
          newText: 'Revised paragraph two mentions beta.',
        },
      ]);
      expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(
        'Revised paragraph two mentions beta.'
      );
      expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(
        'Approve the current layout?'
      );
      expect(readCommentAttachment(doc)).toEqual(initial);
      // Only the emitted edit delta reaches the second client. This checks
      // serialized CRDT propagation and reopening, not server acknowledgement.
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, before));
      expect(readCommentAttachment(peer)).toEqual(initial);
      expect(MarkdownCollabContentAdapter.exportToFile(peer)).toContain(
        'Revised paragraph two mentions beta.'
      );
      withCommentEditor(peer, ({ headless }) =>
        headless.applyUpdate($approveDiffs)
      );
      expect(readCommentAttachment(peer)).toEqual(initial);
    } finally {
      doc.destroy();
      peer.destroy();
    }
  });

  it('applies a replacement inside a real decision fence without silently leaving the old question', () => {
    const doc = commentedDecisionDoc();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(peer);
    try {
      applyMarkdownReplacementsToYDoc(doc, [
        {
          oldText: DECISION,
          newText: DECISION.replace('current layout', 'revised layout'),
        },
      ]);
      expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(
        'Approve the revised layout?'
      );
      expect(readCommentAttachment(doc).threads[0].anchorState).toBe(
        'attached'
      );
      expect(readCommentAttachment(doc).decisionTypes).toEqual(['decision']);
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc, before));
      expect(MarkdownCollabContentAdapter.exportToFile(peer)).toContain(
        'Approve the revised layout?'
      );
      expect(readCommentAttachment(peer).threads).toEqual(
        readCommentAttachment(doc).threads
      );
      expect(readCommentAttachment(peer).decisionTypes).toEqual(['decision']);
    } finally {
      doc.destroy();
      peer.destroy();
    }
  });

  it('lands a decision edit as one final decision with its comment still attached', () => {
    const doc = commentedDecisionDoc();
    try {
      applyMarkdownReplacementsToYDoc(doc, [
        {
          oldText: DECISION,
          newText: DECISION.replace('current layout', 'revised layout'),
        },
      ]);
      expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(
        'Approve the revised layout?'
      );
      expect(readCommentAttachment(doc).threads[0].anchorState).toBe(
        'attached'
      );
      withCommentEditor(doc, ({ headless }) =>
        headless.editor.getEditorState().read(() => {
          const decisions = $getRoot()
            .getChildren()
            .filter((node) => node.getType() === 'decision');
          expect(decisions).toHaveLength(1);
          expect($getDiffState(decisions[0])).toBeNull();
          expect($getOriginalMarkdown(decisions[0])).toBeNull();
        })
      );
    } finally {
      doc.destroy();
    }
  });

  it('control: clear-and-reseed keeps thread data and its quote but orphans the real MarkNode anchor', () => {
    const doc = commentedDecisionDoc();
    const initial = readCommentAttachment(doc);
    expect(initial.threads[0].anchorState).toBe('attached');
    try {
      const markdown = MarkdownCollabContentAdapter.exportToFile(doc) as string;
      MarkdownCollabContentAdapter.applyFromFile(
        doc,
        markdown.replace('current layout', 'revised layout')
      );
      const after = readCommentAttachment(doc);
      expect(after.threads).toEqual(
        initial.threads.map((thread) => ({
          ...thread,
          anchorState: 'orphaned',
        }))
      );
      expect(MarkdownCollabContentAdapter.exportToFile(doc)).toContain(
        COMMENT_QUOTE
      );
      expect(after.decisionTypes).toEqual(['decision']);
    } finally {
      doc.destroy();
    }
  });
});
