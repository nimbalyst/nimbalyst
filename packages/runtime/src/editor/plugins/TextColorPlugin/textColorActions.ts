/**
 * Apply, change and remove text color on the selection.
 *
 * Color is an inline TextColorNode around the run, not a style on each text
 * node, so a change rebuilds the wrappers around the selection:
 *
 *   1. Record each selected leaf's effective color (inner wrappers override
 *      outer ones per property) and the opening tag it was read with.
 *   2. Override the color kind being set on the selected leaves.
 *   3. Unwrap the outermost TextColorNode around each selected leaf. Every
 *      other wrapper in the block is left exactly as it is.
 *   4. Wrap each maximal run of freed sibling leaves (or whole inline elements
 *      such as links) that share a color in one TextColorNode.
 *
 * A run whose color did not change reuses its original opening tag, so colors
 * keep their bytes; runs read with differently spelled tags stay separate. A
 * line break ends a run, because the markdown importer reads a span only
 * within one line.
 */

import {
  $getNodeByKey,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
} from 'lexical';

import { $createTextColorNode, $isTextColorNode, type TextColorNode } from './TextColorNode';
import type { TextColorKind, TextColorStyle } from '../../../core/textColorSyntax';

interface LeafColor {
  style: TextColorStyle;
  rawOpenTag?: string;
}

/** The color of the nearest TextColorNode around the selection anchor, merged with any outer ones. */
export function $getSelectionTextColor(): TextColorStyle {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return {};
  return colorOf(selection.anchor.getNode()).style;
}

/**
 * Set (or with `value` null, remove) one color kind on the selection. A
 * collapsed selection inside colored text changes that whole colored run.
 * Returns false when there was nothing to change.
 */
export function $setSelectionTextColor(kind: TextColorKind, value: string | null): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;

  const wasCollapsed = selection.isCollapsed();
  let targets: LexicalNode[];
  if (wasCollapsed) {
    const wrapper = outermostTextColorNode(selection.anchor.getNode());
    if (!wrapper) return false;
    targets = leavesOf(wrapper);
  } else {
    targets = selection.extract().filter((node) => !$isElementNode(node));
  }
  if (targets.length === 0) return false;

  const property = kind === 'color' ? 'color' : 'backgroundColor';
  const overrides = new Map<NodeKey, TextColorStyle>();
  for (const leaf of targets) {
    const style = { ...colorOf(leaf).style };
    if (value) style[property] = value;
    else delete style[property];
    overrides.set(leaf.getKey(), style);
  }

  const blocks = new Set<ElementNode>();
  for (const leaf of targets) {
    const block = blockOf(leaf);
    if (block) blocks.add(block);
  }
  for (const block of blocks) rebuildBlock(block, overrides);

  // Keep the changed text selected; a collapsed caret stays where it was.
  if (!wasCollapsed) {
    const first = targets[0];
    const last = targets[targets.length - 1];
    if ($isTextNode(first) && $isTextNode(last) && first.isAttached() && last.isAttached()) {
      const end = last.getTextContentSize();
      if (selection.isBackward()) {
        selection.anchor.set(last.getKey(), end, 'text');
        selection.focus.set(first.getKey(), 0, 'text');
      } else {
        selection.anchor.set(first.getKey(), 0, 'text');
        selection.focus.set(last.getKey(), end, 'text');
      }
    }
  }
  return true;
}

function colorOf(node: LexicalNode): LeafColor {
  const wrappers: TextColorNode[] = [];
  let current: LexicalNode | null = $isTextColorNode(node) ? node : node.getParent();
  while (current && !($isElementNode(current) && !current.isInline())) {
    if ($isTextColorNode(current)) wrappers.unshift(current);
    current = current.getParent();
  }
  const style: TextColorStyle = {};
  for (const wrapper of wrappers) Object.assign(style, wrapper.getTextColorStyle());
  return {
    style,
    rawOpenTag: wrappers.length === 1 ? wrappers[0].getRawOpenTag() : undefined,
  };
}

function outermostTextColorNode(node: LexicalNode): TextColorNode | null {
  let found: TextColorNode | null = null;
  let current: LexicalNode | null = node;
  while (current && !($isElementNode(current) && !current.isInline())) {
    if ($isTextColorNode(current)) found = current;
    current = current.getParent();
  }
  return found;
}

function blockOf(node: LexicalNode): ElementNode | null {
  let current = node.getParent();
  while (current && current.isInline()) current = current.getParent();
  return current;
}

function leavesOf(element: ElementNode): LexicalNode[] {
  const leaves: LexicalNode[] = [];
  for (const child of element.getChildren()) {
    if ($isElementNode(child)) leaves.push(...leavesOf(child));
    else leaves.push(child);
  }
  return leaves;
}

function styleKey(style: TextColorStyle | undefined): string {
  if (!style || (!style.color && !style.backgroundColor)) return '';
  return `${style.color ?? ''}|${style.backgroundColor ?? ''}`;
}

function rebuildBlock(block: ElementNode, overrides: Map<NodeKey, TextColorStyle>): void {
  // Only the wrappers around selected leaves are rebuilt; the rest keep their tags and nesting.
  const affected = new Map<NodeKey, TextColorNode>();
  const colors = new Map<NodeKey, LeafColor>();
  for (const [key, style] of overrides) {
    const leaf = $getNodeByKey(key);
    if (!leaf || blockOf(leaf) !== block) continue;
    const wrapper = outermostTextColorNode(leaf);
    if (wrapper) affected.set(wrapper.getKey(), wrapper);
    colors.set(key, { style, rawOpenTag: colorOf(leaf).rawOpenTag });
  }
  for (const wrapper of affected.values()) {
    for (const leaf of leavesOf(wrapper)) {
      if (!colors.has(leaf.getKey())) colors.set(leaf.getKey(), colorOf(leaf));
    }
  }

  for (const wrapper of affected.values()) {
    unwrapTextColorNodes(wrapper);
    for (const child of wrapper.getChildren()) wrapper.insertBefore(child);
    wrapper.remove();
  }
  wrapRuns(block, colors);
}

function unwrapTextColorNodes(element: ElementNode): void {
  for (const child of element.getChildren()) {
    if (!$isElementNode(child) || !child.isInline()) continue;
    unwrapTextColorNodes(child);
    if ($isTextColorNode(child)) {
      for (const grandchild of child.getChildren()) child.insertBefore(grandchild);
      child.remove();
    }
  }
}

/** Tags are compatible when equal or when one side has none (new or changed color). */
function tagsCompatible(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

/**
 * The shared color of a child, or null when it has to be colored inside
 * instead: its leaves differ in color or in how their tags were spelled, or it
 * holds a wrapper that is being left alone.
 */
function unitColor(node: LexicalNode, colors: Map<NodeKey, LeafColor>): LeafColor | null {
  if (!$isElementNode(node)) return colors.get(node.getKey()) ?? { style: {} };
  const leaves = leavesOf(node);
  if (leaves.length === 0) return { style: {} };
  let shared: LeafColor | null = null;
  for (const leaf of leaves) {
    if (hasTextColorAncestorWithin(leaf, node)) return null;
    const color = colors.get(leaf.getKey()) ?? { style: {} };
    if (shared === null) {
      shared = { ...color };
      continue;
    }
    if (styleKey(color.style) !== styleKey(shared.style)) return null;
    if (!tagsCompatible(shared.rawOpenTag, color.rawOpenTag)) return null;
    shared.rawOpenTag ??= color.rawOpenTag;
  }
  return shared;
}

function hasTextColorAncestorWithin(leaf: LexicalNode, root: ElementNode): boolean {
  for (let current = leaf.getParent(); current && !current.is(root); current = current.getParent()) {
    if ($isTextColorNode(current)) return true;
  }
  return false;
}

function wrapRuns(element: ElementNode, colors: Map<NodeKey, LeafColor>): void {
  let run: LexicalNode[] = [];
  let runColor: LeafColor | null = null;

  const flush = () => {
    if (run.length > 0 && runColor && styleKey(runColor.style) !== '') {
      const wrapper = $createTextColorNode(runColor.style, runColor.rawOpenTag);
      run[0].insertBefore(wrapper);
      wrapper.append(...run);
    }
    run = [];
    runColor = null;
  };

  for (const child of element.getChildren()) {
    // A wrapper still here was outside the selection: it stays as written.
    if ($isLineBreakNode(child) || $isTextColorNode(child) || ($isElementNode(child) && !child.isInline())) {
      flush();
      continue;
    }
    const color = unitColor(child, colors);
    if (color === null) {
      // Mixed colors inside a link: color inside it instead of around it.
      flush();
      if ($isElementNode(child)) wrapRuns(child, colors);
      continue;
    }
    if (runColor && styleKey(color.style) === styleKey(runColor.style)
      && tagsCompatible(runColor.rawOpenTag, color.rawOpenTag)) {
      runColor.rawOpenTag ??= color.rawOpenTag;
      run.push(child);
    } else {
      flush();
      run = [child];
      runColor = { ...color };
    }
  }
  flush();
}
