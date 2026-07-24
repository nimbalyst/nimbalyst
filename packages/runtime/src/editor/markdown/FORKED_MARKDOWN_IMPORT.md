# Markdown Fork Inventory

## Current state

As of the Lexical 0.44.0 upgrade, we no longer fork the markdown importer. Both
import and export call upstream `@lexical/markdown` directly:

- `$convertFromEnhancedMarkdownString` (in `EnhancedMarkdownImport.ts`) wraps
  upstream `$convertFromMarkdownString` with frontmatter extraction, list-indent
  normalization, and a small post-import pass that collapses upstream's
  TabNodes back to plain text inside surrounding TextNodes.
- `$convertToEnhancedMarkdownString` (in `EnhancedMarkdownExport.ts`) drives a
  custom export traversal so we can support diff-aware export, frontmatter
  emission, single-node export, and HTML numeric character references for
  literal `*`/`_`. The traversal otherwise mirrors upstream `createMarkdownExport`.

## What is still local-only

| File | Reason |
| --- | --- |
| `EnhancedMarkdownImport.ts` | Frontmatter extraction; pre-import list-indent normalization; post-import TabNode collapse so the diff plugin's tree matcher doesn't have to know about TabNodes. |
| `EnhancedMarkdownExport.ts` | Diff-aware export, single-node export, frontmatter emission, `rejectMode`, and the **NCR encoding for literal `*`/`_`** below. |
| `MarkdownNormalizer.ts` | Detects and rewrites 2-/3-/4-space list indents to a consistent target indent before import. Upstream's importer accepts whatever indent the list-item regex matches; this layer keeps imported documents stable across mixed indent sources. |
| `ListTransformers.ts` | Our 2-space house style for list export. Upstream still hardcodes `LIST_INDENT_SIZE = 4`, so this stays forked until upstream makes indent size configurable. |
| `MarkdownTransformers.ts` | Mostly thin re-exports of upstream `BOLD_*`, `ITALIC_*`, `STRIKETHROUGH`, `HIGHLIGHT`, `INLINE_CODE`, plus our own `HEADING`, `QUOTE`, `CODE` (with a `'plain'` no-language sentinel) and `LINK` (regex with `(?<!!)` to skip image syntax). |
| `MarkdownStreamProcessor.ts` | AI streaming markdown into a live editor; not in upstream. |
| `FrontmatterUtils.ts` | YAML frontmatter parse/serialize and root-state storage; not in upstream. |
| `HashtagTransformer.ts`, `HorizontalRuleTransformer.ts`, `core-transformers.ts` | Nimbalyst node + transformer composition; not in upstream. |

## NCR encoding for literal `*` and `_`

In `exportTextFormat` we encode literal asterisks and underscores in non-code
text as `&#42;` / `&#95;` rather than backslash-escaping them as `\*` / `\_`.

**Why:** upstream Lexical's CommonMark emphasis scanner (`isFlanking` /
`canEmphasis` in `LexicalMarkdown.dev.js`) uses a `PUNCTUATION` regex that does
not include `\`. When a delimiter run sits next to a backslash escape (e.g.
`***\*syntax\****`), the secondary character of the flanking check is `\`,
which is classified as non-punctuation, causing the close run to be marked
non-flanking and the surrounding emphasis to be rejected on re-import.

Numeric character references are inert to the emphasis scanner (they do not
affect flanking) and are converted back to literal characters by upstream's
`unescapeText` after emphasis processing, so a literal `*` adjacent to bold
or italic markers round-trips losslessly. This is the **only** reason we no
longer need a forked importer; without this export change, switching to
upstream import re-introduces drift on real Nimbalyst plan documents.

## What was deleted

- `LexicalMarkdownImport.ts` — the old forked importer that disabled line
  merging and ported upstream's CommonMark emphasis scanner to add `\` to its
  `PUNCTUATION` regex.
- `importTextFormatTransformer.ts`, `importTextMatchTransformer.ts`,
  `importTextTransformers.ts` — copies of upstream internals that supported the
  forked importer.
- `utils.ts` — a stale copy of upstream's pre-`@lexical/markdown` "auto-format"
  criteria system, plus duplicates of `transformersByType` and
  `isEmptyParagraph`. Nothing live referenced its `MarkdownCriteria` exports.

## Taking upstream fixes

Because import goes through upstream directly, future upstream markdown fixes
are picked up by bumping `@lexical/markdown`. Things to re-audit on each bump:

1. Whether `unescapeText` still handles `&#NNN;` numeric character references
   (used by our exporter's NCR encoding).
2. Whether upstream's CommonMark `PUNCTUATION` regex now includes `\`. If yes,
   the NCR encoding becomes optional and we can simplify `exportTextFormat`
   back to standard backslash escaping.
3. Whether `LIST_INDENT_SIZE` becomes configurable. If yes, `ListTransformers`
   can collapse to a thin upstream wrapper.
4. Whether upstream's `$normalizeMarkdownTextNode` (TabNode conversion) gets
   an opt-out. If yes, the post-import `$collapseTabNodes` pass can be deleted.

## Testing

The corpus that motivated this work is in
`__tests__/round-trip-corpus.test.ts`. Other regression coverage lives in
`__tests__/four-space-indent.test.ts`, `__tests__/list-normalization-integration.test.ts`,
`__tests__/ListTransformers.test.ts`, and `__tests__/blank-lines-regression.test.ts`.
