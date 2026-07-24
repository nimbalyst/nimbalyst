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
 *   - lone unpaired `$` with no closing pair on the same line
 *   - currency split across newlines (the regex content class excludes newlines)
 */
const CURRENCY_PAIR_RE = /(?<!\\)\$([^$\n]*?)(?<!\\)\$(?=\d)/g;

export function escapeCurrencyDollars(source: string): string {
  if (!source) {
    return source;
  }
  return source.replace(CURRENCY_PAIR_RE, (_match, content: string) => {
    return `\\$${content}\\$`;
  });
}
