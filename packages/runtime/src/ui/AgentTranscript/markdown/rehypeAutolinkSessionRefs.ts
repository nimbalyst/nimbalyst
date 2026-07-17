/**
 * rehype plugin: autolink bare session UUIDs in transcript markdown.
 *
 * Cross-session tool results (`send_prompt`, `get_session_status`, …) and
 * assistant prose sometimes name another session by its raw UUID. This plugin
 * wraps those UUIDs in anchors whose href is the bare UUID — the renderer's `a`
 * override already turns a UUID href into a live `SessionReferenceChip`.
 *
 * Detection is allow-list gated: only UUIDs that match a KNOWN session id (in
 * `options.sessionIds`) are linked, so unrelated UUIDs (and non-session ids)
 * are never turned into dead session chips.
 *
 * Skips `<a>` (already linked) and `<pre>` (fenced code). Inline `<code>` is
 * linked when the whole node is a single known session id, mirroring the
 * tracker-ref autolinker. No external unist/hast deps.
 */

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

const SKIP_TAGS = new Set(['a', 'pre']);

// Matches a UUID with a non-hex-word boundary on both sides. Membership in the
// known-session set is checked separately (case-insensitively) before linking.
const UUID_RE =
  /(?<![0-9a-fA-F-])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F-])/g;

export interface RehypeAutolinkSessionRefsOptions {
  /** Known session ids eligible for linking. */
  sessionIds: string[];
}

function makeAnchor(id: string): HastElement {
  return {
    type: 'element',
    tagName: 'a',
    properties: { href: id },
    children: [{ type: 'text', value: id }],
  };
}

function textContent(node: HastNode): string {
  if (node.type === 'text') return (node as HastText).value;
  const children = (node as { children?: HastNode[] }).children;
  if (!children) return '';
  return children.map(textContent).join('');
}

function splitTextNode(
  value: string,
  known: Set<string>,
): HastNode[] | null {
  UUID_RE.lastIndex = 0;
  let match: RegExpExecArray | null = UUID_RE.exec(value);
  if (!match) return null;

  const out: HastNode[] = [];
  let lastIndex = 0;
  let mutated = false;

  while (match) {
    const start = match.index;
    const raw = match[0];
    const canonical = known.has(raw) ? raw : known.has(raw.toLowerCase()) ? raw.toLowerCase() : null;
    if (canonical) {
      if (start > lastIndex) {
        out.push({ type: 'text', value: value.slice(lastIndex, start) });
      }
      out.push(makeAnchor(canonical));
      lastIndex = start + raw.length;
      mutated = true;
    }
    match = UUID_RE.exec(value);
  }

  if (!mutated) return null;
  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}

function wholeCodeId(el: HastElement, known: Set<string>): string | null {
  const text = textContent(el).trim();
  if (known.has(text)) return text;
  if (known.has(text.toLowerCase())) return text.toLowerCase();
  return null;
}

function processChildren(
  children: HastNode[],
  known: Set<string>,
): HastNode[] {
  let mutated = false;
  const result: HastNode[] = [];

  for (const child of children) {
    if (child.type === 'text') {
      const split = splitTextNode((child as HastText).value, known);
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

      if (el.tagName === 'code') {
        const id = wholeCodeId(el, known);
        if (id) {
          result.push(makeAnchor(id));
          mutated = true;
          continue;
        }
        result.push(child);
        continue;
      }

      if (!SKIP_TAGS.has(el.tagName) && el.children?.length) {
        const nextChildren = processChildren(el.children, known);
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
      const nextChildren = processChildren(container.children, known);
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
 * Usage: `rehypePlugins={[[rehypeAutolinkSessionRefs, { sessionIds }]]}`.
 */
export function rehypeAutolinkSessionRefs(
  options?: RehypeAutolinkSessionRefsOptions,
) {
  const known = new Set(options?.sessionIds ?? []);
  return (tree: HastRoot): void => {
    if (known.size === 0 || !tree.children?.length) return;
    tree.children = processChildren(tree.children, known);
  };
}

// Exported for unit tests.
export const __test = { splitTextNode, wholeCodeId, UUID_RE };
