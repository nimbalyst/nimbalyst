/**
 * The one text-quote matcher for comment anchors, free of Lexical so the CLI
 * can use it on a Y.Doc it reads without an editor.
 *
 * The editor (`$buildCommentTextIndex` / `resolveAnchorInIndex` in
 * CollabCommentControllerRegistry.ts) and the CLI's published-comments report
 * must agree on whether a thread's quote is found, or a reviewer's comment is
 * highlighted in the browser while the publish report calls it orphaned.
 *
 * A thread is anchored by its quote when `findQuoteMatches` returns exactly
 * one offset; zero or several is unanchored.
 */
import { CollabCommentControllerError, normalizeVisibleCommentText, validateTextQuoteSelector } from './commentValidation';

/**
 * The document text quotes are matched against. Pass one string per top-level
 * root child: the concatenated text of every text node beneath it, with no
 * separator inside the child (list items, table cells and nested blocks run
 * together). Blocks are normalized and joined by a single `\n`, with no
 * trailing separator.
 */
export function joinCommentTextBlocks(blocks: readonly string[]): string {
  return blocks.map((block) => normalizeVisibleCommentText(block)).join('\n');
}

/**
 * Start offsets in `text` where the selector matches: every (even overlapping)
 * occurrence of `exact` whose preceding text ends with `prefix` and whose
 * following text starts with `suffix` (each checked only when non-empty). The
 * selector is normalized first; a selector that fails validation (empty
 * `exact`, or over the size bounds) matches nothing.
 */
export function findQuoteMatches(
  text: string,
  selector: { exact: string; prefix?: string; suffix?: string },
): number[] {
  let normalized: { exact: string; prefix: string; suffix: string };
  try {
    normalized = validateTextQuoteSelector(selector);
  } catch (error) {
    if (error instanceof CollabCommentControllerError) return [];
    throw error;
  }
  const { exact, prefix, suffix } = normalized;
  const matches: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= text.length - exact.length) {
    const index = text.indexOf(exact, searchFrom);
    if (index === -1) break;
    const prefixMatches =
      !prefix ||
      text.slice(Math.max(0, index - prefix.length), index) === prefix;
    const endOffset = index + exact.length;
    const suffixMatches =
      !suffix || text.slice(endOffset, endOffset + suffix.length) === suffix;
    if (prefixMatches && suffixMatches) matches.push(index);
    searchFrom = index + 1;
  }
  return matches;
}

/**
 * Where an existing thread's quote is, or null: the rule every reader of a
 * thread's anchor uses (re-anchoring, decoration highlights, `list()`, the
 * CLI's published-comments report).
 *
 * The full selector first. When its context finds nothing (the quote's
 * neighbours were edited) the bare `exact` text is tried, and accepted only
 * when it occurs exactly once. Context that matches several places never falls
 * back: a repeated quote is ambiguous, and a wrong guess would anchor the
 * thread somewhere else for everyone.
 */
export function findThreadQuoteOffset(
  text: string,
  selector: { exact: string; prefix?: string; suffix?: string },
): number | null {
  const matches = findQuoteMatches(text, selector);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 || (!selector.prefix && !selector.suffix)) return null;
  const exactOnly = findQuoteMatches(text, { exact: selector.exact });
  return exactOnly.length === 1 ? exactOnly[0] : null;
}
