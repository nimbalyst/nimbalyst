/**
 * Marking a selection, editing and removing marks. React-free. Loaded on
 * demand (toolbar action, mark editor), so the eager editor bundle carries
 * only the node and its transformer.
 */

import {
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
} from 'lexical';
import { $findMatchingParent } from '@lexical/utils';

import { $createPageMarkNode, $isPageMarkNode, type PageMarkNode } from './PageMarkNode';
import type { PageMarkAttrs, PageMarkKind } from '../../../core/pageMarkSyntax';
import { OPEN_PAGE_MARK_EDITOR_COMMAND } from './pageMarkEvents';
import { getDefaultPageMarkAuthor } from './pageMarkHost';


export function $findPageMark(node: LexicalNode | null | undefined): PageMarkNode | null {
  if (!node) return null;
  return $findMatchingParent(node, $isPageMarkNode) as PageMarkNode | null;
}

/** The nearest block (non-inline element) holding `node`. */
function $blockOf(node: LexicalNode): ElementNode | null {
  return $findMatchingParent(node, (candidate) => $isElementNode(candidate) && !candidate.isInline()) as ElementNode | null;
}

/**
 * The ancestor of `node` (or `node` itself) whose parent is `block`. Compared
 * by key: `selection.extract()` makes the block writable, so its parent
 * pointer is a different object from the `block` read before the split.
 */
function $childOf(block: ElementNode, node: LexicalNode): LexicalNode | null {
  let current: LexicalNode | null = node;
  while (current && !current.getParent()?.is(block)) current = current.getParent();
  return current;
}

/**
 * Wraps the selected inline run in a mark. The selection must start and end in
 * the same paragraph or list item; a partly selected link is taken whole.
 * When the selection is already inside a mark, that mark is returned unchanged.
 * Returns null when nothing can be marked.
 */
export function $markSelection(attrs: PageMarkAttrs): PageMarkNode | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const existing = $findPageMark(selection.anchor.getNode()) ?? $findPageMark(selection.focus.getNode());
  if (existing) return existing;
  if (selection.isCollapsed()) return null;
  const block = $blockOf(selection.anchor.getNode());
  if (!block || !block.is($blockOf(selection.focus.getNode()))) return null;

  const extracted = selection.extract();
  const children: LexicalNode[] = [];
  for (const node of extracted) {
    const child = $childOf(block, node);
    if (!child || children.includes(child)) continue;
    if ($isElementNode(child) && !child.isInline()) return null;
    children.push(child);
  }
  if (children.length === 0) return null;
  // Keep document order regardless of selection direction.
  children.sort((a, b) => a.getIndexWithinParent() - b.getIndexWithinParent());
  const mark = $createPageMarkNode(attrs);
  children[0].insertBefore(mark);
  mark.append(...children);
  mark.selectEnd();
  return mark;
}

/** Replaces the mark with its own children. */
export function $removePageMark(nodeKey: NodeKey): boolean {
  const mark = $getNodeByKey(nodeKey);
  if (!$isPageMarkNode(mark)) return false;
  for (const child of mark.getChildren()) mark.insertBefore(child);
  mark.remove();
  return true;
}

export function $updatePageMark(nodeKey: NodeKey, attrs: PageMarkAttrs): boolean {
  const mark = $getNodeByKey(nodeKey);
  if (!$isPageMarkNode(mark)) return false;
  mark.setAttrs(attrs);
  return true;
}

/** `YYYY-MM-DD` for `date` in local time. */
export function todayIsoDate(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Marks the editor's selection with the default author (and today, for a
 * decision), then opens the mark editor on it once the mark is on screen.
 * Inside an existing mark, opens that mark instead.
 */
export function markSelectionAndOpen(editor: LexicalEditor, kind: PageMarkKind): void {
  editor.update(() => {
    const mark = $markSelection({
      kind,
      ...getDefaultPageMarkAuthor(),
      ...(kind === 'decided' ? { on: todayIsoDate() } : {}),
    });
    if (!mark) return;
    const nodeKey = mark.getKey();
    editor.update(() => {}, {
      onUpdate: () => editor.dispatchCommand(OPEN_PAGE_MARK_EDITOR_COMMAND, nodeKey),
    });
  });
}

export function updatePageMark(editor: LexicalEditor, nodeKey: NodeKey, attrs: PageMarkAttrs): void {
  editor.update(() => {
    $updatePageMark(nodeKey, attrs);
  });
}

export function removePageMark(editor: LexicalEditor, nodeKey: NodeKey): void {
  editor.update(() => {
    $removePageMark(nodeKey);
  });
}
