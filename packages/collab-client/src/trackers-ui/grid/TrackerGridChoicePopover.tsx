/**
 * The choice list a select or people cell opens, the same list a field chip
 * opens, anchored under the cell being edited, with a filter to type into.
 *
 * Typing on a selected cell starts the edit with that key, so the filter opens
 * holding it: type a name and press Enter. Arrow keys move through the matches
 * while the keys stay in the filter.
 *
 * RevoGrid editors render Stencil vnodes, so the cell editor mounts this in its
 * own React root (`mountTrackerGridChoicePopover`) and tears it down when
 * RevoGrid disconnects the editor. RevoGrid reads keys at the document, so the
 * popover keeps its own keys from reaching the grid.
 */

import React, { useCallback, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot } from 'react-dom/client';
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
import {
  TrackerFieldChoiceList,
  type TrackerFieldChoice,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldChoiceList';

export interface TrackerGridChoicePopoverProps {
  anchor: Element;
  choices: readonly TrackerFieldChoice[];
  /** The stored value. */
  value: string;
  /** What was typed to start the edit, if anything. */
  initialQuery?: string;
  onPick: (value: string) => void;
  onCancel: () => void;
}

/**
 * Choices whose label or value contains the query, case-insensitively: a word
 * of the label starting with it first, then the label containing it, then only
 * the value (an email) containing it -- "g" should find Greg before gmail.com.
 */
export function filterTrackerFieldChoices(choices: readonly TrackerFieldChoice[], query: string): TrackerFieldChoice[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...choices];
  const rank = (choice: TrackerFieldChoice): number => {
    const label = choice.label.toLowerCase();
    if (label.split(/[\s@._+-]+/).some(word => word.startsWith(needle))) return 0;
    if (label.includes(needle)) return 1;
    return choice.value.toLowerCase().includes(needle) ? 2 : -1;
  };
  return choices
    .map((choice, index) => ({ choice, index, rank: rank(choice) }))
    .filter(entry => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.choice);
}

export function TrackerGridChoicePopover({ anchor, choices, value, initialQuery = '', onPick, onCancel }: TrackerGridChoicePopoverProps) {
  const [query, setQuery] = useState(initialQuery);
  // Focus the filter when it attaches, not in a mount effect: `FloatingPortal`
  // mounts its children a render later, so an effect here finds no input and
  // the keys stay with the grid. Not `autoFocus` either: the popover sits at the
  // page origin until it is positioned, and focus would scroll there.
  const focusedRef = useRef(false);
  const focusOnAttach = useCallback((input: HTMLInputElement | null) => {
    if (!input || focusedRef.current) return;
    focusedRef.current = true;
    input.focus({ preventScroll: true });
  }, []);
  const filtered = useMemo(() => filterTrackerFieldChoices(choices, query), [choices, query]);
  // "None" only while nothing is typed: a typed name means someone.
  const allowNone = !query.trim();
  const keys = useMemo(() => [...(allowNone ? [''] : []), ...filtered.map(choice => choice.value)], [allowNone, filtered]);
  const [active, setActive] = useState<string | undefined>(undefined);
  // Typing moves the keyboard to the first match; with nothing typed it starts on the stored value.
  const activeValue = active !== undefined && keys.includes(active)
    ? active
    : !query.trim() && keys.includes(value) ? value : keys[allowNone && keys.length > 1 ? 1 : 0];

  const floating = useFloating({
    open: true,
    onOpenChange: (open) => { if (!open) onCancel(); },
    elements: { reference: anchor },
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
        },
      }),
    ],
  });
  const dismiss = useDismiss(floating.context);
  const role = useRole(floating.context, { role: 'listbox' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (activeValue !== undefined) onPick(activeValue);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = activeValue === undefined ? -1 : keys.indexOf(activeValue);
    const next = event.key === 'ArrowDown' ? Math.min(keys.length - 1, at + 1) : Math.max(0, at - 1);
    setActive(keys[next]);
  };

  return (
    <FloatingPortal>
      <div
        ref={floating.refs.setFloating}
        style={floating.floatingStyles}
        {...getFloatingProps({ onKeyDown })}
        className="tracker-field-popover tracker-grid-choice-popover"
        data-testid="tracker-grid-choice-popover"
      >
        <input
          ref={focusOnAttach}
          type="text"
          className="tracker-grid-choice-filter"
          placeholder="Filter..."
          aria-label="Filter choices"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(undefined);
          }}
        />
        {keys.length === 0 ? (
          <div className="tracker-grid-choice-empty">No matches</div>
        ) : (
          <TrackerFieldChoiceList choices={filtered} value={value} allowNone={allowNone} activeValue={activeValue} onPick={onPick} />
        )}
      </div>
    </FloatingPortal>
  );
}

/** Mounts the popover in its own root; the returned function unmounts it. */
export function mountTrackerGridChoicePopover(props: TrackerGridChoicePopoverProps): () => void {
  // The grid cell the edit started from, so closing hands the keys back to it.
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const container = document.createElement('div');
  container.className = 'tracker-grid-choice-root';
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(<TrackerGridChoicePopover {...props} />);
  return () => {
    // Only if focus is still ours: a click on another cell has already moved it there.
    const active = document.activeElement;
    const focusIsOurs = !active || active === document.body || Boolean(active.closest('.tracker-grid-choice-popover'));
    // RevoGrid disconnects the editor from inside its own render pass; React
    // refuses a synchronous unmount there.
    queueMicrotask(() => {
      root.unmount();
      container.remove();
      if (focusIsOurs && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    });
  };
}
