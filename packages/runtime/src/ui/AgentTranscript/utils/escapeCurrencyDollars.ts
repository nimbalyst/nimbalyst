/**
 * Escape currency-pattern dollar signs in markdown source so they are not
 * misinterpreted as inline-math delimiters by remark-math when the transcript
 * is rendered.
 *
 * Greg s lexical-editor fix (baf60b4e9 / PR #449) tightened the editor s own
 * inline-math regex to pandoc rules: opening `$` must not be followed by
 * whitespace, closing `$` must not be preceded by whitespace and must not be
 * followed by a digit. That fix lives in
 * `packages/extensions/math/src/lexical/MathTransformers.ts` and only covers
 * the Lexical editor used for opened markdown files.
 *
 * The agent-transcript path that renders Claude/Codex output is separate. It
 * uses `remarkMath` + `rehypeKatex` (mounted by `TranscriptMathHost`), and
 * `remark-math` 6 does not implement the pandoc closing-followed-by-digit
 * rule, so text like `$7M in SaaS ARR ... $40M in ARR` is still collapsed as
 * KaTeX in the transcript. See nimbalyst/nimbalyst#462.
 *
 * The dominant false-positive pattern Greg s tests cover is the closing `$`
 * followed by a digit (currency followed by another currency amount). This
 * function pre-escapes exactly that pattern by replacing the surrounding `$`
 * characters with `\$`, which remark-math then renders as literal text.
 *
 * Cases preserved:
 *   - legitimate inline math `$x = 5$` (closing `$` followed by space, not digit)
 *   - display math `$$...$$` (no digit immediately after `$$`)
 *   - already-escaped currency `\$5 to \$10` (skipped via lookbehind)
 *   - lone unpaired `$` with no closing pair on the same or the next line
 *   - currency split across a blank line (a paragraph boundary)
 *
 * A pair split across a single soft line break *is* escaped: remark-math pairs
 * any two `$` inside one paragraph, so `$990/mo.` + newline + `$1,500` was
 * rendering as math (nimbalyst/nimbalyst#1385).
 *
 * Code is exempt (nimbalyst/nimbalyst#1373). A backslash is not an escape
 * character inside `code` / `inlineCode`, so escaping there is not invisible
 * the way it is in prose: `awk '{print $1, $2}'` renders — and copies — as
 * `awk '{print \$1, \$2}'`, and the copied command no longer runs.
 *
 * The exempt regions come from a real parse rather than a line scan, because a
 * scan cannot see fences inside blockquotes or list items, nested fences, or
 * inline spans. The escape still happens on the *source*, before the document
 * is parsed for rendering, so markdown that crosses a currency span survives:
 * `from $7M to **$40M**` stays bold, which reverting `inlineMath` nodes after
 * the fact would not preserve.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent } from 'mdast';

// The content may cross one soft line break (nimbalyst/nimbalyst#1385), but
// never a blank line: that is a paragraph boundary, and remark-math will not
// pair across it either.
const CURRENCY_PAIR_RE = /(?<!\\)\$([^$\n]*?(?:\n(?![ \t]*\n)[^$\n]*?)?)(?<!\\)\$(?=\d)/g;

/** Backtick/tilde fence or span, or an indented code line. */
const MAY_CONTAIN_CODE_RE = /[`~]|^(?: {4}|\t)/m;

const codeScanProcessor = unified().use(remarkParse).use(remarkGfm);

function escapeSegment(segment: string): string {
  return segment.replace(CURRENCY_PAIR_RE, (_match, content: string) => `\\$${content}\\$`);
}

/** Source offsets of every `code` / `inlineCode` node, in document order. */
function collectCodeRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const walk = (node: Root | RootContent): void => {
    if ((node.type === 'code' || node.type === 'inlineCode') && node.position) {
      const { start, end } = node.position;
      if (start.offset !== undefined && end.offset !== undefined) {
        ranges.push([start.offset, end.offset]);
      }
      return;
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child as RootContent);
      }
    }
  };
  walk(codeScanProcessor.parse(source));
  return ranges.sort((a, b) => a[0] - b[0]);
}

export function escapeCurrencyDollars(source: string): string {
  if (!source) {
    return source;
  }

  // Nothing to escape: skip the parse entirely. This is the common case, so
  // the code-range scan never runs for the vast majority of transcript text.
  CURRENCY_PAIR_RE.lastIndex = 0;
  if (!CURRENCY_PAIR_RE.test(source)) {
    return source;
  }

  // No construct that could produce a code node: the whole source is fair game.
  if (!MAY_CONTAIN_CODE_RE.test(source)) {
    return escapeSegment(source);
  }

  let result = '';
  let cursor = 0;
  for (const [start, end] of collectCodeRanges(source)) {
    if (start < cursor) {
      continue;
    }
    result += escapeSegment(source.slice(cursor, start)) + source.slice(start, end);
    cursor = end;
  }
  return result + escapeSegment(source.slice(cursor));
}
