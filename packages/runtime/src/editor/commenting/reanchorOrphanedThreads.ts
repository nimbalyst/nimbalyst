/**
 * Re-attach comment threads whose MarkNode was lost but whose quoted text
 * survives.
 *
 * A shared document rebuilt from markdown loses every MarkNode: markdown has no
 * syntax for a comment mark, so `root.clear()` + `$convertFromMarkdown` (the
 * path agent edits take through `applyCollabDocEdit`) drops all of them while
 * leaving the thread data and the document text intact. The threads then report
 * `anchorState: 'orphaned'` and their highlights stop rendering (#2644).
 *
 * Healing is by exact quote match only. A thread whose quote was rewritten, or
 * whose quote now occurs more than once, is left orphaned on purpose — these
 * writes go into the shared Y.Doc, so a wrong guess is permanent and visible to
 * everyone.
 *
 * The match is the thread's text-quote selector (`getThreadQuoteSelector`)
 * under `findThreadQuoteOffset`: its prefix/suffix context first, else the
 * bare quote when it occurs exactly once, so a thread whose neighbours were
 * edited still re-attaches. A commenter's quote-only thread gains a MarkNode
 * the first time a client that may edit the body opens the page.
 * Callers must not run this for a user without body-edit rights.
 */
import { $wrapSelectionInMarkNode } from '@lexical/mark';
import {
  $createRangeSelection,
  $getSelection,
  $setSelection,
  type LexicalEditor,
} from 'lexical';

import {
  CollabCommentControllerError,
  collectMarkIds,
  $buildCommentTextIndex,
  getThreadQuoteSelector,
  resolveThreadAnchorInIndex,
} from './CollabCommentControllerRegistry';
import type { Thread } from './index';

export interface ReanchorResult {
  /** Thread ids that regained a MarkNode. */
  reattached: string[];
  /** Threads left orphaned, with the anchor error code that stopped them. */
  skipped: Array<{ id: string; reason: string }>;
}

export function reanchorOrphanedThreads(
  editor: LexicalEditor | undefined,
  threads: readonly Thread[],
): ReanchorResult {
  const result: ReanchorResult = { reattached: [], skipped: [] };
  if (!editor) return result;

  const attached = collectMarkIds(editor);
  const orphaned = threads.filter(
    (thread) => getThreadQuoteSelector(thread) && !attached.has(thread.id),
  );
  if (orphaned.length === 0) return result;

  editor.update(
    () => {
      // Restore whatever the user had selected: $wrapSelectionInMarkNode needs
      // the range installed as the active selection, and this runs in the
      // background rather than in response to a click.
      const previous = $getSelection();
      const restore = previous ? previous.clone() : null;

      for (const thread of orphaned) {
        let resolved;
        try {
          // Re-resolved per thread: each wrap splits text nodes, so offsets
          // from a single up-front pass would be stale after the first mark.
          const selector = getThreadQuoteSelector(thread)!;
          // Context first, then the bare quote when it is unique; a repeated
          // quote stays orphaned (findThreadQuoteOffset).
          resolved = resolveThreadAnchorInIndex($buildCommentTextIndex(), {
            exact: selector.exact,
            prefix: selector.prefix,
            suffix: selector.suffix,
          });
        } catch (error) {
          result.skipped.push({
            id: thread.id,
            reason:
              error instanceof CollabCommentControllerError
                ? error.code
                : 'ANCHOR_NOT_FOUND',
          });
          continue;
        }

        const selection = $createRangeSelection();
        selection.anchor.set(resolved.start.key, resolved.start.offset, 'text');
        selection.focus.set(resolved.end.key, resolved.end.offset, 'text');
        $setSelection(selection);
        $wrapSelectionInMarkNode(selection, false, thread.id);
        result.reattached.push(thread.id);
      }

      $setSelection(restore);
    },
    { discrete: true },
  );

  return result;
}
