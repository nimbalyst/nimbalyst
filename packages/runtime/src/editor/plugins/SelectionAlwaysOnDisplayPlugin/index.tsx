/**
 * In-tree replacement for `@lexical/react/LexicalSelectionAlwaysOnDisplay`.
 *
 * Why: upstream's `markSelection` (in `@lexical/utils`) calls
 * `editorState.read(cb)` without passing `{ editor }`, so the active editor is
 * `null` inside the callback. In Lexical 0.34 this was harmless. In 0.44,
 * `$rangeTargetFromPoint` was rewritten to call `$getEditor()` whenever a
 * selection endpoint is an ElementNode-typed point (e.g. caret on an empty
 * paragraph) -- and the missing active editor now throws
 * "Unable to find an active editor". This file inlines the same logic with
 * `editorState.read(cb, { editor })` so the read callback binds an active
 * editor. Drop this file the moment upstream lands the same fix.
 *
 * See: node_modules/@lexical/utils/LexicalUtils.dev.js lines 225-322.
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { positionNodeOnRange } from '@lexical/utils';
import {
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  getDOMTextNode,
  mergeRegister,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type PointType,
  type RangeSelection,
} from 'lexical';
import { useEffect } from 'react';

type OnReposition = (nodes: ReadonlyArray<HTMLElement>) => void;

const px = (n: number): string => `${n}px`;

function defaultOnReposition(domNodes: ReadonlyArray<HTMLElement>): void {
  for (const domNode of domNodes) {
    const s = domNode.style;
    if (s.background !== 'Highlight') s.background = 'Highlight';
    if (s.color !== 'HighlightText') s.color = 'HighlightText';
    if (s.marginTop !== px(-1.5)) s.marginTop = px(-1.5);
    if (s.paddingTop !== px(4)) s.paddingTop = px(4);
    if (s.paddingBottom !== px(0)) s.paddingBottom = px(0);
  }
}

function $getOrderedSelectionPoints(
  selection: RangeSelection,
): [PointType, PointType] {
  const points = selection.getStartEndPoints();
  if (!points) {
    // RangeSelection always returns points; this branch exists only to
    // satisfy the type-narrowing -- defensive but unreachable in practice.
    throw new Error('RangeSelection without start/end points');
  }
  return selection.isBackward() ? [points[1], points[0]] : points;
}

function $rangeTargetFromPoint(
  point: PointType,
  node: LexicalNode,
  dom: HTMLElement,
): [Node, number] {
  if (point.type === 'text' || !$isElementNode(node)) {
    const textDOM = getDOMTextNode(dom) || dom;
    return [textDOM, point.offset];
  }
  // We're inside `editorState.read(cb, { editor })`, so `node.getDOMSlot`
  // resolves via the default render config (which itself just calls
  // `node.getDOMSlot(dom)`). No `$getEditor()` lookup needed.
  const slot = (node as ElementNode).getDOMSlot(dom);
  return [slot.element, slot.getFirstChildOffset() + point.offset];
}

function $rangeFromPoints(
  editor: LexicalEditor,
  start: PointType,
  startNode: LexicalNode,
  startDOM: HTMLElement,
  end: PointType,
  endNode: LexicalNode,
  endDOM: HTMLElement,
): Range {
  const editorDocument = editor._window ? editor._window.document : document;
  const range = editorDocument.createRange();
  range.setStart(...$rangeTargetFromPoint(start, startNode, startDOM));
  range.setEnd(...$rangeTargetFromPoint(end, endNode, endDOM));
  return range;
}

function markSelection(
  editor: LexicalEditor,
  onReposition: OnReposition = defaultOnReposition,
): () => void {
  let previousAnchorNode: LexicalNode | null = null;
  let previousAnchorNodeDOM: HTMLElement | null = null;
  let previousAnchorOffset: number | null = null;
  let previousFocusNode: LexicalNode | null = null;
  let previousFocusNodeDOM: HTMLElement | null = null;
  let previousFocusOffset: number | null = null;
  let removeRangeListener: () => void = () => {};

  function compute(editorState: EditorState): void {
    // The fix: pass `{ editor }` so `editorState.read` sets the active
    // editor for the duration of the callback. Without it, anything inside
    // that calls `$getEditor()` -- including `$rangeTargetFromPoint`'s
    // element-point branch in Lexical 0.44 -- throws.
    editorState.read(
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          previousAnchorNode = null;
          previousAnchorOffset = null;
          previousFocusNode = null;
          previousFocusOffset = null;
          removeRangeListener();
          removeRangeListener = () => {};
          return;
        }
        const [start, end] = $getOrderedSelectionPoints(selection);
        const currentStartNode = start.getNode();
        const currentStartNodeKey = currentStartNode.getKey();
        const currentStartOffset = start.offset;
        const currentEndNode = end.getNode();
        const currentEndNodeKey = currentEndNode.getKey();
        const currentEndOffset = end.offset;
        const currentStartNodeDOM = editor.getElementByKey(currentStartNodeKey);
        const currentEndNodeDOM = editor.getElementByKey(currentEndNodeKey);
        const differentStartDOM =
          previousAnchorNode === null ||
          currentStartNodeDOM !== previousAnchorNodeDOM ||
          currentStartOffset !== previousAnchorOffset ||
          currentStartNodeKey !== previousAnchorNode.getKey();
        const differentEndDOM =
          previousFocusNode === null ||
          currentEndNodeDOM !== previousFocusNodeDOM ||
          currentEndOffset !== previousFocusOffset ||
          currentEndNodeKey !== previousFocusNode.getKey();
        if (
          (differentStartDOM || differentEndDOM) &&
          currentStartNodeDOM !== null &&
          currentEndNodeDOM !== null
        ) {
          const range = $rangeFromPoints(
            editor,
            start,
            currentStartNode,
            currentStartNodeDOM,
            end,
            currentEndNode,
            currentEndNodeDOM,
          );
          removeRangeListener();
          removeRangeListener = positionNodeOnRange(
            editor,
            range,
            onReposition as (nodes: Array<HTMLElement>) => void,
          );
        }
        previousAnchorNode = currentStartNode;
        previousAnchorNodeDOM = currentStartNodeDOM;
        previousAnchorOffset = currentStartOffset;
        previousFocusNode = currentEndNode;
        previousFocusNodeDOM = currentEndNodeDOM;
        previousFocusOffset = currentEndOffset;
      },
      { editor },
    );
  }

  compute(editor.getEditorState());
  return mergeRegister(
    editor.registerUpdateListener(({ editorState }) => compute(editorState)),
    () => {
      removeRangeListener();
    },
  );
}

function selectionAlwaysOnDisplay(
  editor: LexicalEditor,
  onReposition?: OnReposition,
): () => void {
  let removeSelectionMark: (() => void) | null = null;
  const onSelectionChange = (): void => {
    const domSelection = getSelection();
    const domAnchorNode = domSelection && domSelection.anchorNode;
    const editorRootElement = editor.getRootElement();
    const isSelectionInsideEditor =
      domAnchorNode !== null &&
      editorRootElement !== null &&
      editorRootElement.contains(domAnchorNode);
    if (isSelectionInsideEditor) {
      if (removeSelectionMark !== null) {
        removeSelectionMark();
        removeSelectionMark = null;
      }
    } else if (removeSelectionMark === null) {
      removeSelectionMark = markSelection(editor, onReposition);
    }
  };
  return editor.registerRootListener((rootElement) => {
    if (!rootElement) {
      return undefined;
    }
    const ownerDocument = rootElement.ownerDocument;
    ownerDocument.addEventListener('selectionchange', onSelectionChange);
    onSelectionChange();
    return () => {
      if (removeSelectionMark !== null) {
        removeSelectionMark();
      }
      ownerDocument.removeEventListener('selectionchange', onSelectionChange);
    };
  });
}

type Props = Readonly<{
  onReposition?: OnReposition;
}>;

export function SelectionAlwaysOnDisplay({ onReposition }: Props = {}): null {
  const [editor] = useLexicalComposerContext();
  useEffect(
    () => selectionAlwaysOnDisplay(editor, onReposition),
    [editor, onReposition],
  );
  return null;
}
