/**
 * Types for `@nimbalyst/runtime/editor/commenting/quoteMatch`, the editor's
 * Lexical-free comment quote matcher (packages/runtime/src/editor/commenting/quoteMatch.ts),
 * used by `nim wiki comments` and the publish report so a thread's anchor
 * state matches what reviewers see in the editor.
 *
 * Wired like pageMarkSyntax.d.ts: tsconfig.json `paths` points tsc here while
 * scripts/build.mjs and vitest.config.ts alias the specifier to the source.
 * Keep these a subset of that file's exports.
 */
export interface QuoteSelector {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/** The page text the editor matches quotes in: one string per top-level block, joined as the editor joins them. */
export function joinCommentTextBlocks(blocks: readonly string[]): string;

/** Offsets in `text` where the selector matches; exactly one means the thread is anchored by its quote. */
export function findQuoteMatches(text: string, selector: QuoteSelector): number[];

/**
 * Where an existing thread's quote is, or null: the full selector, else the
 * bare `exact` when the context finds nothing and it occurs exactly once.
 */
export function findThreadQuoteOffset(text: string, selector: QuoteSelector): number | null;
