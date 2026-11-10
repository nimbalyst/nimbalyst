/**
 * Comment marks are not markdown, and the markdown exporter is not neutral to
 * them: it closes and reopens a format run at a mark's edges, so
 * `**beta gamma**` marked on "beta" came out as `****beta** gamma**` and a mark
 * over part of inline code split it into two code spans. A commented document
 * then exported as edited, and the collab server's last-write comparison
 * refused it as `body_edited`.
 *
 * Every export of a collaborative body therefore runs on a state with its
 * comment marks unwrapped. Lexical's normalization merges the split text back
 * into the unmarked runs, so the result is byte-identical with and without
 * marks. Unwrapping is a write, so it only ever happens on a private copy.
 */
import { $isMarkNode, $unwrapMarkNode, type MarkNode } from '@lexical/mark';
import { createHeadlessEditor } from '@lexical/headless';
import { $getRoot, $isElementNode, type LexicalEditor, type LexicalNode } from 'lexical';
import { applyUpdate, Doc, encodeStateAsUpdate } from 'yjs';

import type { HeadlessLexicalYDoc } from './HeadlessLexicalYDoc';

function $collectCommentMarks(node: LexicalNode, into: MarkNode[]): MarkNode[] {
  if ($isMarkNode(node)) into.push(node);
  if ($isElementNode(node)) {
    for (const child of node.getChildren()) $collectCommentMarks(child, into);
  }
  return into;
}

/** Whether the current editor state holds any comment mark. Read context. */
export function $hasCommentMarks(): boolean {
  return $collectCommentMarks($getRoot(), []).length > 0;
}

/** Unwrap every comment mark, innermost first. Update context, private copies only. */
export function $unwrapCommentMarks(): void {
  for (const mark of $collectCommentMarks($getRoot(), []).reverse()) {
    $unwrapMarkNode(mark);
  }
}

/**
 * Run `read` over `yDoc`'s body with comment marks removed, without writing to
 * `yDoc`. A document with no marks is read in place; one with marks is copied
 * into a private Y.Doc, unwrapped there, and read from the copy.
 *
 * `bind` opens a headless editor over a Y.Doc (the caller's node set and
 * bridge); `read` runs inside that editor's read context.
 */
export function readWithoutCommentMarks<T>(
  yDoc: Doc,
  bind: <R>(doc: Doc, fn: (headless: HeadlessLexicalYDoc) => R) => R,
  read: () => T,
): T {
  const inPlace = bind(yDoc, (headless) =>
    headless.editor.getEditorState().read(() =>
      $hasCommentMarks() ? { marked: true as const } : { marked: false as const, value: read() },
    ),
  );
  if (!inPlace.marked) return inPlace.value;

  const copy = new Doc();
  try {
    applyUpdate(copy, encodeStateAsUpdate(yDoc));
    return bind(copy, (headless) => {
      headless.applyUpdate($unwrapCommentMarks);
      return headless.editor.getEditorState().read(read);
    });
  } finally {
    copy.destroy();
  }
}

/**
 * Run `read` over a live editor's state with comment marks removed, without
 * writing to that editor. With no marks it reads in place; otherwise the state
 * is copied into a scratch headless editor with the same nodes and unwrapped
 * there.
 */
export function readEditorWithoutCommentMarks<T>(editor: LexicalEditor, read: () => T): T {
  const state = editor.getEditorState();
  if (!state.read($hasCommentMarks)) return state.read(read);
  const nodes = editor._createEditorArgs?.nodes;
  if (!nodes) throw new Error('readEditorWithoutCommentMarks: editor has no node list');
  const scratch = createHeadlessEditor({ nodes, onError: (error) => { throw error; } });
  scratch.setEditorState(scratch.parseEditorState(state.toJSON()));
  scratch.update($unwrapCommentMarks, { discrete: true });
  return scratch.getEditorState().read(read);
}
