/**
 * rehype plugin: autolink bare file paths in transcript markdown.
 *
 * Agent providers (notably Claude Code) frequently mention files as plain
 * text (`packages/electron/src/foo.ts`, `/Users/me/foo.ts:42`) rather than as
 * markdown links. `MarkdownRenderer` only turns real markdown links into
 * clickable file-open actions, so those bare mentions render as dead text.
 *
 * This plugin walks the hast tree, finds path-shaped substrings inside text
 * nodes, and wraps them in `<a>` elements carrying a `dataFilePath` property.
 * The renderer's `a` override recognizes that marker and routes the click
 * through `onOpenFile` (which resolves workspace-relative paths via the
 * `workspace:open-file` IPC handler).
 *
 * Detection is deliberately conservative (see `FILE_PATH_RE`):
 * - requires a path separator AND a file extension, so bare `foo.ts`,
 *   `and/or`, version strings like `v1.2.3`, and prose are not linked. The
 *   separator requirement also keeps bare-filename inline code (`` `foo.tsx` ``)
 *   from becoming dead links to `<workspace>/foo.tsx`.
 * - inline code (`<code>`) IS linked — agents most often cite files as
 *   `` `packages/a/foo.ts` ``. Fenced code blocks (`<pre>`) and text already
 *   inside an `<a>` are never touched, so source listings and author-written
 *   links are left alone. (Fenced code lives under `<pre>`, which is skipped,
 *   so any `<code>` the walker reaches is inline.)
 *
 * No external unist/hast deps — the runtime package does not ship them — so
 * the tree walk and node types are kept local and minimal.
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

type HastNode = HastText | HastElement | HastRoot | { type: string; children?: HastNode[] };

// Tags whose subtree must not be autolinked: fenced code blocks (`<pre>`, and
// by extension the `<code>` they wrap) and any text already inside a link.
// Inline `<code>` is intentionally NOT skipped — it is the most common way
// agents cite files. Because `<pre>` is skipped here, the walker only ever
// reaches inline `<code>`.
const SKIP_TAGS = new Set(['a', 'pre']);

/**
 * Matches absolute, Windows, and workspace-relative file paths with an
 * optional `:line` / `:line:col` suffix.
 *
 * A match always requires at least one path separator and a final
 * `.<ext>` (1-8 alphanumerics), which keeps bare filenames, prose, and
 * version numbers out. Segment characters are restricted to a path-safe
 * set so trailing sentence punctuation (`.`, `,`, `)`, `:`) is excluded.
 */
const FILE_PATH_RE =
  // eslint-disable-next-line no-useless-escape
  /(?<![\w@:./\\-])((?:[A-Za-z]:[\\/]|\\\\|~\/|\.\.?\/|\/)?(?:[\w.@-]+[\\/])+[\w.@-]+\.[A-Za-z0-9]{1,8})(:\d+(?::\d+)?)?/g;

function makeAnchor(fullMatch: string): HastElement {
  return {
    type: 'element',
    tagName: 'a',
    properties: {
      href: fullMatch,
      // Marker read by the renderer's `a` override. Carries the raw match
      // (path plus any :line:col suffix); the override strips the suffix
      // before handing the path to onOpenFile.
      dataFilePath: fullMatch,
    },
    children: [{ type: 'text', value: fullMatch }],
  };
}

/**
 * Split a text node's value into a sequence of text/anchor nodes.
 * Returns null when there are no path matches (caller keeps the node as-is).
 */
function splitTextNode(value: string): HastNode[] | null {
  FILE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null = FILE_PATH_RE.exec(value);
  if (!match) return null;

  const out: HastNode[] = [];
  let lastIndex = 0;

  while (match) {
    const start = match.index;
    const fullMatch = match[0];
    if (start > lastIndex) {
      out.push({ type: 'text', value: value.slice(lastIndex, start) });
    }
    out.push(makeAnchor(fullMatch));
    lastIndex = start + fullMatch.length;
    match = FILE_PATH_RE.exec(value);
  }

  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}

function processChildren(children: HastNode[]): HastNode[] {
  let mutated = false;
  const result: HastNode[] = [];

  for (const child of children) {
    if (child.type === 'text') {
      const split = splitTextNode((child as HastText).value);
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
      // Do not descend into code/pre/existing links — leave their subtree intact.
      if (!SKIP_TAGS.has(el.tagName) && el.children?.length) {
        const nextChildren = processChildren(el.children);
        if (nextChildren !== el.children) {
          result.push({ ...el, children: nextChildren });
          mutated = true;
          continue;
        }
      }
      result.push(child);
      continue;
    }

    // Other container nodes (root never appears here): recurse if it has children.
    const container = child as { type: string; children?: HastNode[] };
    if (container.children?.length) {
      const nextChildren = processChildren(container.children);
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
 * rehype plugin entry point. Usage: `rehypePlugins={[rehypeAutolinkFilePaths]}`.
 */
export function rehypeAutolinkFilePaths() {
  return (tree: HastRoot): void => {
    if (tree.children?.length) {
      tree.children = processChildren(tree.children);
    }
  };
}

// Exported for unit tests.
export const __test = { splitTextNode, FILE_PATH_RE };
