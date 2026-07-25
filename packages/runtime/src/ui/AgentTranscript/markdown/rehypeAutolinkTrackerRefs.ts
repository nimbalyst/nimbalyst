/**
 * rehype plugin: autolink bare tracker keys in transcript markdown.
 *
 * Agents frequently mention tracker items as plain text (`NIM-1639`, often
 * bolded) rather than as the `[NIM-1639](nimbalyst://NIM-1639)` link form the
 * renderer turns into a live status chip. Those bare mentions render as dead
 * text. This plugin walks the hast tree, finds tracker-key substrings inside
 * text nodes, and wraps them in `<a href="nimbalyst://KEY">` elements — the
 * renderer's `a` override already recognizes that URN and renders a
 * `TrackerReferenceChip`.
 *
 * Detection is prefix-gated: only keys whose prefix is one this workspace
 * actually uses (passed in `options.prefixes`, derived from existing issue
 * keys) are linked. This keeps `UTF-8`, `COVID-19`, `ISO-9001`, and version
 * strings out — a token only links if a matching tracker prefix exists.
 *
 * Skipped subtrees:
 * - `<pre>` (fenced code blocks) and `<a>` (already-linked text, including the
 *   author-written `[NIM-123](nimbalyst://…)` links) are never touched.
 * - Inline `<code>` is linked ONLY when the whole node's trimmed content is a
 *   single tracker key (`` `NIM-123` `` -> chip). A key embedded in larger
 *   inline code (`` `run NIM-123 now` ``) is left intact so code samples aren't
 *   corrupted.
 *
 * No external unist/hast deps — the runtime package does not ship them — so the
 * tree walk and node types are kept local and minimal (mirrors
 * `rehypeAutolinkFilePaths`).
 */

import { TRACKER_REFERENCE_URN_SCHEME } from '../../../plugins/TrackerLinkPlugin/TrackerReferenceNode';

interface HastText {
  type: 'text';
  value: string;
}

interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}

interface HastRoot {
  type: 'root';
  children: HastNode[];
}

type HastNode =
  | HastText
  | HastElement
  | HastRoot
  | { type: string; children?: HastNode[] };

// Tags whose subtree must not be autolinked: fenced code blocks (`<pre>`) and
// any text already inside a link. Inline `<code>` is handled specially (see
// module docstring) and is NOT in this set.
const SKIP_TAGS = new Set(['a', 'pre']);

export interface RehypeAutolinkTrackerRefsOptions {
  /** Uppercased issue-key prefixes eligible for linking (e.g. `['NIM']`). */
  prefixes: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a global, case-insensitive matcher for the given prefixes, or null when
 * there are none. Requires a non-word/non-hyphen boundary on both sides so
 * `xNIM-1` and `NIM-1x`-style substrings don't match.
 */
function buildKeyRegExp(prefixes: string[]): RegExp | null {
  const cleaned = prefixes.map(p => p.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  const alternation = cleaned.map(escapeRegExp).join('|');
  return new RegExp(
    `(?<![\\w-])(?:${alternation})-\\d+(?![\\w-])`,
    'gi',
  );
}

function makeAnchor(key: string): HastElement {
  return {
    type: 'element',
    tagName: 'a',
    properties: {
      href: `${TRACKER_REFERENCE_URN_SCHEME}${key}`,
    },
    children: [{ type: 'text', value: key }],
  };
}

/** Normalize a matched key so its prefix is uppercase (`nim-12` -> `NIM-12`). */
function normalizeKey(match: string): string {
  const dash = match.indexOf('-');
  if (dash < 0) return match.toUpperCase();
  return `${match.slice(0, dash).toUpperCase()}${match.slice(dash)}`;
}

/**
 * Split a text node's value into a sequence of text/anchor nodes.
 * Returns null when there are no key matches (caller keeps the node as-is).
 */
function splitTextNode(value: string, keyRe: RegExp): HastNode[] | null {
  keyRe.lastIndex = 0;
  let match: RegExpExecArray | null = keyRe.exec(value);
  if (!match) return null;

  const out: HastNode[] = [];
  let lastIndex = 0;

  while (match) {
    const start = match.index;
    const fullMatch = match[0];
    if (start > lastIndex) {
      out.push({ type: 'text', value: value.slice(lastIndex, start) });
    }
    out.push(makeAnchor(normalizeKey(fullMatch)));
    lastIndex = start + fullMatch.length;
    match = keyRe.exec(value);
  }

  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}

/** Concatenated text of a node's direct + nested text children. */
function textContent(node: HastNode): string {
  if (node.type === 'text') return (node as HastText).value;
  const children = (node as { children?: HastNode[] }).children;
  if (!children) return '';
  return children.map(textContent).join('');
}

/**
 * If an inline `<code>` node's entire trimmed content is a single tracker key,
 * return the normalized key; otherwise null (leave the code untouched).
 */
function wholeCodeKey(el: HastElement, keyRe: RegExp): string | null {
  const text = textContent(el).trim();
  if (!text) return null;
  keyRe.lastIndex = 0;
  const match = keyRe.exec(text);
  if (match && match.index === 0 && match[0].length === text.length) {
    return normalizeKey(match[0]);
  }
  return null;
}

function processChildren(children: HastNode[], keyRe: RegExp): HastNode[] {
  let mutated = false;
  const result: HastNode[] = [];

  for (const child of children) {
    if (child.type === 'text') {
      const split = splitTextNode((child as HastText).value, keyRe);
      if (split) {
        result.push(...split);
        mutated = true;
        continue;
      }
      result.push(child);
      continue;
    }

    if (child.type === 'element') {
      const el = child as HastElement;

      // Inline code: link only when the WHOLE node is a single key.
      if (el.tagName === 'code') {
        const key = wholeCodeKey(el, keyRe);
        if (key) {
          result.push(makeAnchor(key));
          mutated = true;
          continue;
        }
        result.push(child);
        continue;
      }

      // Never descend into fenced code or existing links.
      if (!SKIP_TAGS.has(el.tagName) && el.children?.length) {
        const nextChildren = processChildren(el.children, keyRe);
        if (nextChildren !== el.children) {
          result.push({ ...el, children: nextChildren });
          mutated = true;
          continue;
        }
      }
      result.push(child);
      continue;
    }

    const container = child as { type: string; children?: HastNode[] };
    if (container.children?.length) {
      const nextChildren = processChildren(container.children, keyRe);
      if (nextChildren !== container.children) {
        result.push({ ...container, children: nextChildren } as HastNode);
        mutated = true;
        continue;
      }
    }
    result.push(child);
  }

  return mutated ? result : children;
}

/**
 * rehype plugin entry point.
 * Usage: `rehypePlugins={[[rehypeAutolinkTrackerRefs, { prefixes }]]}`.
 */
export function rehypeAutolinkTrackerRefs(
  options?: RehypeAutolinkTrackerRefsOptions,
) {
  const keyRe = buildKeyRegExp(options?.prefixes ?? []);
  return (tree: HastRoot): void => {
    if (!keyRe || !tree.children?.length) return;
    tree.children = processChildren(tree.children, keyRe);
  };
}

// Exported for unit tests.
export const __test = {
  buildKeyRegExp,
  splitTextNode,
  normalizeKey,
  wholeCodeKey,
};
