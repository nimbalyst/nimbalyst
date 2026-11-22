/**
 * rehype plugin: colored text in transcript markdown.
 *
 * `<span style="color: #f03e3e">**Blocked**</span>` is the markdown form of
 * colored text (see `core/textColorSyntax.ts`). CommonMark parses each tag as
 * its own raw-HTML node, with the markdown between them as ordinary nodes;
 * react-markdown later prints every raw node as literal text. This plugin
 * pairs an opening tag with its `</span>` in the same parent and replaces the
 * pair with a real `span` element around the nodes between them.
 *
 * Only a span whose sole attribute is a `style` declaring `color` and/or
 * `background-color` with a safe value is converted, the same rule the editor
 * uses. Any other raw HTML is left alone and shows as text. Palette colors are
 * drawn through the `--nim-text-color-*` / `--nim-text-bg-*` theme variables.
 *
 * Runs before the autolink plugins so text inside a colored span still links.
 * No unist/hast dependencies, matching the other transcript plugins.
 */

import {
  formatTextColorStyle,
  parseTextColorStyle,
  textColorRenderStyle,
  type TextColorStyle,
} from '../../../core/textColorSyntax';

interface HastRaw {
  type: 'raw';
  value: string;
}

interface HastParent {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

type HastNode = HastRaw | HastParent;

const OPEN_TAG = /^<span\s+style\s*=\s*(?:"([^"]*)"|'([^']*)')\s*>$/i;
const ANY_OPEN_SPAN = /^<span\b[^>]*>$/i;
const CLOSE_SPAN = /^<\/span\s*>$/i;

function rawValue(node: HastNode): string | null {
  return node.type === 'raw' && typeof (node as HastRaw).value === 'string' ? (node as HastRaw).value.trim() : null;
}

function openTagStyle(node: HastNode): TextColorStyle | null {
  const value = rawValue(node);
  const match = value ? OPEN_TAG.exec(value) : null;
  return match ? parseTextColorStyle(match[1] ?? match[2] ?? '') : null;
}

/** Index of the `</span>` that closes the span opened at `openIndex`, or -1. */
function findClose(children: HastNode[], openIndex: number): number {
  let depth = 1;
  for (let i = openIndex + 1; i < children.length; i++) {
    const value = rawValue(children[i]);
    if (value === null) continue;
    if (CLOSE_SPAN.test(value)) depth -= 1;
    else if (ANY_OPEN_SPAN.test(value)) depth += 1;
    if (depth === 0) return i;
  }
  return -1;
}

function renderStyle(style: TextColorStyle): string {
  const render = textColorRenderStyle(style);
  return formatTextColorStyle({ color: render.color, backgroundColor: render.backgroundColor });
}

function transformChildren(parent: HastParent): void {
  const children = parent.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const style = openTagStyle(children[i]);
    if (style) {
      const close = findClose(children, i);
      if (close > i + 1) {
        const span: HastParent = {
          type: 'element',
          tagName: 'span',
          properties: { className: ['transcript-text-color'], style: renderStyle(style) },
          children: children.slice(i + 1, close),
        };
        children.splice(i, close - i + 1, span);
      }
    }
    const child = children[i];
    if (child.type !== 'raw' && !(child.type === 'element' && (child as HastParent).tagName === 'pre')) {
      transformChildren(child as HastParent);
    }
  }
}

export function rehypeTextColorSpans() {
  return (tree: HastParent) => {
    transformChildren(tree);
  };
}
