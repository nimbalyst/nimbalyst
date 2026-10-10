/**
 * Function autocomplete list and signature help for a formula being edited.
 *
 * Controlled: the host computes `autocomplete` / `signatureHelp` from its text
 * and caret (`getFormulaAutocomplete`, `getSignatureHelp`) and applies an
 * accepted name itself (`applyAutocomplete`). Focus never leaves the editor;
 * the popover listens for keys on `keyTarget` in the capture phase and
 * swallows only the ones it handles, so the editor's own Enter/Escape/arrow
 * handling does not also run.
 */

import { useEffect, useRef, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import type { FunctionCatalogEntry } from '../formula/functionCatalog';
import type { FormulaAutocomplete, SignatureHelp } from '../formula/formulaAssist';

export interface FormulaAssistPopoverProps {
  /** The element the popover sits under: the formula bar input or the in-cell editor. */
  anchor: HTMLElement | null;
  /** Where key events arrive. Defaults to `anchor`. */
  keyTarget?: HTMLElement | null;
  autocomplete: FormulaAutocomplete | null;
  signatureHelp: SignatureHelp | null;
  /** Tab, Enter or a click on a candidate. */
  onAccept: (entry: FunctionCatalogEntry) => void;
  /** Escape while the popover is showing. */
  onDismiss: () => void;
}

function formatParams(
  entry: FunctionCatalogEntry,
  activeIndex: number,
): Array<{ text: string; active: boolean }> {
  return entry.params.map((param, index) => {
    const name = param.repeating ? `${param.name}, ...` : param.name;
    return { text: param.optional ? `[${name}]` : name, active: index === activeIndex };
  });
}

function Signature({ entry, activeIndex }: { entry: FunctionCatalogEntry; activeIndex: number }) {
  const params = formatParams(entry, activeIndex);
  return (
    <span className="csv-formula-assist-signature font-mono text-[11px] text-nim-muted whitespace-nowrap">
      <span className="text-nim">{entry.name}</span>(
      {params.map((param, index) => (
        <span key={index}>
          {index > 0 ? ', ' : ''}
          {param.active ? <b className="text-nim font-bold underline">{param.text}</b> : param.text}
        </span>
      ))}
      )
    </span>
  );
}

export function FormulaAssistPopover({
  anchor,
  keyTarget,
  autocomplete,
  signatureHelp,
  onAccept,
  onDismiss,
}: FormulaAssistPopoverProps) {
  const [highlighted, setHighlighted] = useState(0);
  const candidates = autocomplete?.candidates ?? [];
  const visible = anchor !== null && (candidates.length > 0 || signatureHelp !== null);

  // A new prefix is a new list; start from its best match.
  useEffect(() => setHighlighted(0), [autocomplete?.prefix, autocomplete?.replaceStart]);

  const { refs, floatingStyles } = useFloating({
    elements: { reference: anchor },
    open: visible,
    placement: 'bottom-start',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  // Read through a ref so the listener is attached once per target, not per keystroke.
  const latest = useRef({ candidates, highlighted, visible, onAccept, onDismiss });
  latest.current = { candidates, highlighted, visible, onAccept, onDismiss };

  const target = keyTarget ?? anchor;
  useEffect(() => {
    if (!target) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const state = latest.current;
      if (!state.visible || event.isComposing) return;
      const listOpen = state.candidates.length > 0;
      let handled = true;
      if (event.key === 'Escape') {
        state.onDismiss();
      } else if (listOpen && event.key === 'ArrowDown') {
        setHighlighted((state.highlighted + 1) % state.candidates.length);
      } else if (listOpen && event.key === 'ArrowUp') {
        setHighlighted((state.highlighted - 1 + state.candidates.length) % state.candidates.length);
      } else if (listOpen && (event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        state.onAccept(state.candidates[Math.min(state.highlighted, state.candidates.length - 1)]);
      } else {
        handled = false;
      }
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    target.addEventListener('keydown', handleKeyDown, true);
    return () => target.removeEventListener('keydown', handleKeyDown, true);
  }, [target]);

  if (!visible) return null;
  const active = candidates[highlighted];

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className="csv-formula-assist-popover z-50 w-72 overflow-hidden bg-nim-secondary border border-nim rounded-md shadow-lg text-nim text-[12px]"
      >
        {candidates.length > 0 ? (
          <>
            <div role="listbox" aria-label="Functions" className="csv-formula-assist-list flex flex-col py-1 max-h-60 overflow-y-auto">
              {candidates.map((entry, index) => (
                <div
                  key={entry.name}
                  role="option"
                  aria-selected={index === highlighted}
                  className={`csv-formula-assist-option flex items-baseline gap-2 px-2.5 py-1 cursor-pointer ${index === highlighted ? 'bg-nim-selected' : 'hover:bg-nim-hover'}`}
                  // mousedown, not click: the editor must keep focus.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onAccept(entry);
                  }}
                  onMouseEnter={() => setHighlighted(index)}
                >
                  <span className="font-mono font-semibold">{entry.name}</span>
                  <span className="text-nim-faint text-[11px] truncate">{entry.category === 'named range' ? entry.signature : entry.category}</span>
                </div>
              ))}
            </div>
            {active && (
              <div className="csv-formula-assist-detail px-2.5 py-2 border-t border-nim">
                {active.category !== 'named range' && <Signature entry={active} activeIndex={-1} />}
                <div className="mt-1 text-[11.5px] text-nim-muted leading-snug">{active.description}</div>
              </div>
            )}
          </>
        ) : signatureHelp && (
          <div className="csv-formula-assist-signature-help px-2.5 py-2">
            <Signature entry={signatureHelp.entry} activeIndex={signatureHelp.paramIndex} />
            <div className="mt-1.5 text-[11.5px] text-nim-muted leading-snug">{signatureHelp.entry.description}</div>
          </div>
        )}
      </div>
    </FloatingPortal>
  );
}
