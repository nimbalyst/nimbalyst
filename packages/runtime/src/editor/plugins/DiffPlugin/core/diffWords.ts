import {diffWordsWithSpace} from 'diff';
import {DiffSegment} from './diffUtils';

/**
 * Word-level diff between two strings.
 *
 * Returns segments labeled `equal`, `insert`, or `delete`. Backed by the
 * `diff` package's LCS-based `diffWordsWithSpace`, which finds common
 * subsequences (not just common prefix + common suffix). This matters when
 * changes happen at BOTH ends of the input -- e.g. a bullet whose **bold**
 * prefix changes AND whose trailing plain text grows. A prefix/suffix-only
 * walk would give up there and produce a whole-line replacement, leaving the
 * unchanged middle marked as both removed and added.
 *
 * We use `diffWordsWithSpace` (not the whitespace-tolerant `diffWords`)
 * because callers reconstruct the OLD text from `delete` + `equal` segments
 * and the NEW text from `insert` + `equal` segments. `diffWords` absorbs
 * surrounding whitespace into `equal` chunks, which can come from either
 * side -- so concatenating delete+equal can produce text the OLD never
 * contained (e.g., extra spaces around punctuation), breaking reject.
 * `diffWordsWithSpace` keeps each whitespace run as its own token so both
 * reconstructions are exact. The trade-off is more granular change groups
 * for completely-different sentences (one delete/insert per word instead of
 * one for the whole phrase); that's noisier but visually adjacent and
 * structurally correct.
 *
 * Adjacent segments of the same type are already merged by the upstream
 * implementation, so we don't need to post-process.
 */
export function diffWords(oldText: string, newText: string): DiffSegment[] {
  if (oldText === newText) {
    return [{text: oldText, type: 'equal'}];
  }

  const changes = diffWordsWithSpace(oldText, newText);
  const segments: DiffSegment[] = [];

  for (const change of changes) {
    const type: DiffSegment['type'] = change.added
      ? 'insert'
      : change.removed
        ? 'delete'
        : 'equal';
    segments.push({text: change.value, type});
  }

  return segments;
}
