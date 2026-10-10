/**
 * Copy, cut and paste through the native clipboard events.
 *
 * The events' DataTransfer carries every format at once: copy writes TSV of
 * the displayed values, an HTML table, and our JSON with the raw cells; paste
 * prefers that JSON (formulas, refs shifted), then an HTML table, then TSV.
 * The handlers stop the events so RevoGrid's own clipboard listener (on
 * `document`) never applies a second, unrecorded paste. Text fields inside the
 * grid -- the open cell editor -- keep native text copy/paste.
 */

import { useEffect, type RefObject } from 'react';
import type { EditorCore } from './editorCore';

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
}

export function useGridClipboard(
  core: EditorCore,
  { enabled, pasteValuesOnlyRef }: { enabled: boolean; pasteValuesOnlyRef: RefObject<boolean> },
): void {
  useEffect(() => {
    const container = core.gridContainerRef.current;
    if (!enabled || !container) return;

    const onCopyOrCut = (event: ClipboardEvent) => {
      if (isTextField(event.target) || !event.clipboardData) return;
      const range = core.selectionRangeRef.current;
      const gridOps = core.gridOpsRef.current;
      if (!range || !gridOps) return;
      const cut = event.type === 'cut';
      if (cut && core.editingLockedRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      if (cut) void gridOps.cutSelection(range, event.clipboardData);
      else void gridOps.copySelection(range, event.clipboardData);
    };

    const onPaste = (event: ClipboardEvent) => {
      if (isTextField(event.target) || !event.clipboardData) return;
      const range = core.selectionRangeRef.current;
      const gridOps = core.gridOpsRef.current;
      event.preventDefault();
      event.stopPropagation();
      const valuesOnly = pasteValuesOnlyRef.current;
      pasteValuesOnlyRef.current = false;
      if (!range || !gridOps || core.editingLockedRef.current) return;
      // DataTransfer is only readable during the event; `paste` reads it
      // before its first await.
      void gridOps.paste(range, { valuesOnly, transfer: event.clipboardData }).catch((error) => {
        console.error('[CSV] Paste failed:', error);
      });
    };

    container.addEventListener('copy', onCopyOrCut);
    container.addEventListener('cut', onCopyOrCut);
    container.addEventListener('paste', onPaste);
    return () => {
      container.removeEventListener('copy', onCopyOrCut);
      container.removeEventListener('cut', onCopyOrCut);
      container.removeEventListener('paste', onPaste);
    };
  }, [enabled, core, pasteValuesOnlyRef]);
}
