/**
 * Cmd+K: insert or edit the link on the active cell, in a small dialog
 * anchored to the cell. The cell text it writes comes from `format/linkCell.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import type { EditorCore } from '../editor/editorCore';
import { findCellElement } from '../editor/cellElement';
import { rejectEntry } from '../editor/rejectEntry';
import { RangeIndex } from '../cells/sheetDecorations';
import { readCellLink, writeCellLink, type CellLink } from '../format/linkCell';
import { decodeHyperlink } from '../utils/format/parse';

export interface LinkTarget {
  readonly row: number;
  readonly col: number;
}

/** Loads the cell, shows the dialog, writes the result as one command. */
export function LinkDialogHost({ core, target, onClose }: { core: EditorCore; target: LinkTarget | null; onClose: () => void }) {
  const [loaded, setLoaded] = useState<{ target: LinkTarget; link: CellLink; urlColumn: boolean; rect: DOMRect } | null>(null);

  useEffect(() => {
    setLoaded(null);
    const gridOps = core.gridOpsRef.current;
    if (!target || !gridOps) return;
    let cancelled = false;
    void (async () => {
      const meta = core.spreadsheetMetaRef.current.getMetadata();
      const format = new RangeIndex(meta.cellFormats).at(target.row, target.col) ?? meta.columnFormats[target.col];
      const urlColumn = format?.type === 'url';
      const raw = await gridOps.getCellRawValue(target.row, target.col);
      const value = await gridOps.getCellValue(target.row, target.col);
      const shown = typeof value === 'string' ? (decodeHyperlink(value)?.label ?? value) : String(value ?? '');
      const cell = findCellElement(core, target.row, target.col);
      const rect = cell?.getBoundingClientRect() ?? core.gridContainerRef.current?.getBoundingClientRect() ?? new DOMRect();
      if (!cancelled) setLoaded({ target, link: readCellLink(raw, shown, urlColumn), urlColumn, rect });
    })();
    return () => { cancelled = true; };
  }, [core, target]);

  if (!loaded || loaded.target !== target) return null;

  const close = () => {
    onClose();
    // The dialog took focus from the grid; give it back for the next keystroke.
    setTimeout(() => core.gridContainerRef.current?.focus({ preventScroll: true }), 0);
  };
  const save = (link: CellLink) => {
    const gridOps = core.gridOpsRef.current;
    const cells = [{ row: loaded.target.row, col: loaded.target.col, value: writeCellLink(link, loaded.urlColumn) }];
    if (gridOps && !core.editingLockedRef.current && !rejectEntry(core, cells)) {
      void gridOps.executor.execute({ type: 'setCells', cells });
    }
    close();
  };

  return <LinkDialog rect={loaded.rect} initial={loaded.link} urlColumn={loaded.urlColumn} onSave={save} onClose={close} />;
}

function LinkDialog({ rect, initial, urlColumn, onSave, onClose }: {
  rect: DOMRect;
  initial: CellLink;
  urlColumn: boolean;
  onSave: (link: CellLink) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial.text);
  const [url, setUrl] = useState(initial.url);
  // State, not refs: FloatingPortal mounts its children a render after this
  // component, so a mount effect would still see null elements.
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [urlInput, setUrlInput] = useState<HTMLInputElement | null>(null);
  const reference = useMemo(() => ({ getBoundingClientRect: () => rect }), [rect]);
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (next) => { if (!next) onClose(); },
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const { setPositionReference, setFloating } = refs;
  const panelRef = useCallback((node: HTMLDivElement | null) => { setPanel(node); setFloating(node); }, [setFloating]);
  useEffect(() => { setPositionReference(reference); }, [reference, setPositionReference]);
  const { getFloatingProps } = useInteractions([useDismiss(context), useRole(context, { role: 'dialog' })]);

  useEffect(() => { urlInput?.focus(); urlInput?.select(); }, [urlInput]);

  // Keys typed here must not reach the grid's document-level key handling, so
  // they stop at the panel, natively; Enter and Escape are handled on the way.
  const latest = useRef({ text, url, onSave, onClose });
  latest.current = { text, url, onSave, onClose };
  useEffect(() => {
    if (!panel) return;
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        latest.current.onSave({ text: latest.current.text, url: latest.current.url });
      } else if (event.key === 'Escape') {
        event.preventDefault();
        latest.current.onClose();
      }
    };
    panel.addEventListener('keydown', onKey);
    return () => panel.removeEventListener('keydown', onKey);
  }, [panel]);

  const input = 'w-full px-2 py-1 text-[12px] bg-nim-secondary text-nim border border-nim rounded outline-none focus:border-[var(--nim-primary)]';
  return (
    <FloatingPortal>
      <div
        ref={panelRef}
        style={floatingStyles}
        className="csv-link-dialog z-[1000] w-[300px] p-3 flex flex-col gap-2 bg-nim border border-nim rounded-md shadow-[0_6px_20px_rgba(0,0,0,0.35)] text-[12px] text-nim"
        aria-label={urlColumn ? 'Edit URL' : 'Insert link'}
        {...getFloatingProps()}
      >
        {!urlColumn && (
          <label className="flex flex-col gap-1">
            <span className="text-nim-muted">Text</span>
            <input className={`csv-link-text ${input}`} value={text} onChange={(event) => setText(event.target.value)} />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-nim-muted">URL</span>
          <input
            ref={setUrlInput}
            className={`csv-link-url ${input}`}
            value={url}
            placeholder="https://"
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        {initial.editable === false && <span className="text-nim-muted">Saving replaces the cell's formula.</span>}
        <div className="flex justify-end gap-2 pt-1">
          {initial.url && !urlColumn && (
            <button type="button" className="csv-link-remove mr-auto px-2 py-1 rounded text-nim-muted hover:text-nim hover:bg-nim-hover"
              onClick={() => onSave({ text, url: '' })}>
              Remove link
            </button>
          )}
          <button type="button" className="px-2 py-1 rounded text-nim-muted hover:text-nim hover:bg-nim-hover" onClick={onClose}>Cancel</button>
          <button type="button" className="csv-link-apply px-3 py-1 rounded bg-[var(--nim-primary)] text-white" onClick={() => onSave({ text, url })}>
            Apply
          </button>
        </div>
      </div>
    </FloatingPortal>
  );
}
