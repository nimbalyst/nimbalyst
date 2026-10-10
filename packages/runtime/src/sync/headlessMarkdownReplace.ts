/**
 * Apply text replacements to a headless Lexical editor bound to a Y.Doc, with
 * the SAME reconciliation the mounted editor uses: the change lands as a
 * minimal delta, so a collaborator's in-flight typing and comment anchors
 * survive. Used by the desktop renderer (`headlessMarkdownEdit.ts`, with the
 * live extension transformers) and the collab worker (`markdownYDoc.ts`, with
 * the headless set), so both have one edit semantics.
 *
 * The cheap alternative -- project to markdown, string-replace, and replace
 * the whole body -- is a `$getRoot().clear()` plus reparse, which lands in the
 * room as a wholesale replacement that clobbers concurrent typing and orphans
 * every comment anchor.
 *
 * This mirrors `DiffExtension`'s APPLY_MARKDOWN_REPLACE_COMMAND handler --
 * deliberately, and including its failure behaviour. A failed text match must
 * behave here exactly as it does on screen; a headless path that "helpfully"
 * diverged would be a second, untested set of edit semantics reachable only
 * when nobody is looking (a guess-on-failure path once duplicated content).
 *
 * Must stay React-, DOM- and CSS-free; `@nimbalyst/markdown-ydoc` bundles it.
 */
import type { Transformer } from '@lexical/markdown';
import type { LexicalEditor } from 'lexical';

import { $convertToEnhancedMarkdownString } from '../editor/markdown/EnhancedMarkdownExport';
import { applyMarkdownReplace, type TextReplacement } from '../editor/plugins/DiffPlugin/core/diffUtils';

export interface HeadlessTextReplacement {
  /** Absent or empty: replace the whole document. */
  oldText?: string;
  newText: string;
}

export function applyMarkdownReplacementsToHeadlessEditor(
  editor: LexicalEditor,
  replacements: readonly HeadlessTextReplacement[],
  transformers: Transformer[],
): void {
  const originalMarkdown = editor
    .getEditorState()
    .read(() => $convertToEnhancedMarkdownString(transformers));
  // An absent `oldText` means "replace the whole document", the same
  // normalization the mounted command handler applies.
  const normalized: TextReplacement[] = replacements.map((replacement) => ({
    ...replacement,
    oldText: replacement.oldText || originalMarkdown,
  }));
  applyMarkdownReplace(
    editor,
    originalMarkdown,
    normalized,
    transformers,
    // A failed match must fail. The mounted editor falls back to a
    // structural guess that rewrites the FIRST list in the document when a
    // list-shaped `oldText` misses -- survivable on screen, silent
    // deletion here.
    // A shared document takes the edit as final text, never a pending
    // diff written into the room for every collaborator to see.
    { exactTextMatchRequired: true, acceptChanges: true },
  );
}
