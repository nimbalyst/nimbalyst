/**
 * The two floating surfaces data validation adds over the grid: the option
 * list of a dropdown cell, and the message shown when a reject-mode rule
 * refuses a typed value. Both anchor to the cell's rect through @floating-ui.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import type { ListOption } from '../validation/types';

function useCellAnchor(rect: DOMRect, open: boolean, onClose: () => void, placement: 'bottom-start' | 'top-start') {
  const reference = useMemo(() => ({ getBoundingClientRect: () => rect }), [rect]);
  const floating = useFloating({
    open,
    onOpenChange: (next) => { if (!next) onClose(); },
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(2),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(120, Math.min(320, availableHeight))}px`;
        },
      }),
    ],
  });
  const { setPositionReference } = floating.refs;
  useEffect(() => { setPositionReference(reference); }, [reference, setPositionReference]);
  return floating;
}

export function ValidationDropdown({ rect, options, value, onPick, onClose }: {
  rect: DOMRect;
  options: readonly ListOption[];
  value: string;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((option) => option.value === value)));
  const { refs, floatingStyles, context } = useCellAnchor(rect, true, onClose, 'bottom-start');
  const { getFloatingProps } = useInteractions([useDismiss(context), useRole(context, { role: 'listbox' })]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') setActive((i) => Math.min(options.length, i + 1));
      else if (event.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
      else if (event.key === 'Enter') onPick(active === options.length ? '' : options[active]?.value ?? '');
      else if (event.key === 'Escape') onClose();
      else {
        // Typing replaces the value instead, as in Sheets: close the list and
        // let the key reach the grid, which opens the cell editor with it.
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) onClose();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    // Capture on the document so the grid's own key handling never sees these.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active, options, onPick, onClose]);

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={{ ...floatingStyles, minWidth: Math.max(140, rect.width) }}
        className="csv-validation-dropdown"
        {...getFloatingProps()}
      >
        {options.map((option, index) => (
          <button
            key={option.value}
            type="button"
            role="option"
            aria-selected={option.value === value}
            className={`csv-validation-option ${index === active ? 'csv-validation-option-active' : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => onPick(option.value)}
          >
            <span className={`csv-chip csv-chip-${option.color && option.color !== 'default' ? option.color : 'neutral'}`}>
              <span className="csv-chip-label">{option.value}</span>
            </span>
          </button>
        ))}
        <button
          type="button"
          role="option"
          aria-selected={value === ''}
          className={`csv-validation-option csv-validation-clear ${active === options.length ? 'csv-validation-option-active' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActive(options.length)}
          onClick={() => onPick('')}
        >
          Clear
        </button>
      </div>
    </FloatingPortal>
  );
}

export function ValidationMessage({ rect, message, onClose }: { rect: DOMRect; message: string; onClose: () => void }) {
  const { refs, floatingStyles, context } = useCellAnchor(rect, true, onClose, 'bottom-start');
  const { getFloatingProps } = useInteractions([useDismiss(context), useRole(context, { role: 'tooltip' })]);
  useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);
  return (
    <FloatingPortal>
      <div ref={refs.setFloating} style={floatingStyles} className="csv-validation-message" role="alert" {...getFloatingProps()}>
        <strong>Invalid value.</strong> {message}
      </div>
    </FloatingPortal>
  );
}
