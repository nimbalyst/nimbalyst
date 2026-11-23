/**
 * A dropdown you can type into. Typing narrows the list. The arrow keys move
 * through it, Enter or a click picks one, and Escape closes it. The box shows
 * the picked name again when the list closes.
 */

import { FloatingPortal, autoUpdate, flip, offset, size, useDismiss, useFloating, useInteractions, useListNavigation, useRole } from '@floating-ui/react';
import { useId, useRef, useState, type RefObject } from 'react';

import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

export interface PickerOption {
  id: string;
  name: string;
  /** One line under the name. */
  detail: string;
  /** The text that typing is matched against. */
  words: string;
}

interface HookPickerProps {
  /** The test id prefix: `<testId>-input` and `<testId>-option-<id>`. */
  testId: string;
  label: string;
  options: readonly PickerOption[];
  picked: string;
  onPick: (id: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}

export function HookPicker({ testId, label, options, picked, onPick, inputRef }: HookPickerProps) {
  const [open, setOpen] = useState(false);
  // Null while nothing is typed. Then the box shows the picked name.
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const listRef = useRef<Array<HTMLElement | null>>([]);
  const idPrefix = useId();

  const setOpenAndReset = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery(null);
      setActiveIndex(null);
    }
  };
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpenAndReset,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      size({
        padding: 8,
        apply({ rects, availableHeight, elements }) {
          Object.assign(elements.floating.style, { width: `${rects.reference.width}px`, maxHeight: `${Math.max(120, availableHeight)}px` });
        },
      }),
    ],
  });
  // The focus stays in the box. The arrow keys only move the highlight.
  const navigation = useListNavigation(context, { listRef, activeIndex, onNavigate: setActiveIndex, virtual: true, loop: true });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([useRole(context, { role: 'listbox' }), useDismiss(context), navigation]);

  const typed = (query ?? '').trim().toLowerCase();
  const shown = options.filter((option) => typed === '' || option.words.toLowerCase().includes(typed));
  const pickedName = options.find((option) => option.id === picked)?.name ?? '';
  const choose = (id: string) => {
    onPick(id);
    setOpenAndReset(false);
  };

  return (
    <div className="hook-picker relative">
      <input
        ref={(node) => {
          refs.setReference(node);
          if (inputRef !== undefined) inputRef.current = node;
        }}
        data-testid={`${testId}-input`}
        aria-label={label}
        aria-autocomplete="list"
        placeholder="Type to search"
        className="w-full cursor-pointer select-text rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] py-1 pl-2 pr-7"
        {...getReferenceProps({
          value: query ?? pickedName,
          // The whole name is selected, so the first letter typed starts a new search.
          onFocus: (event) => (event.currentTarget as HTMLInputElement).select(),
          // A click opens the list, and a click while it is open closes it.
          onClick: () => (open ? setOpenAndReset(false) : setOpen(true)),
          onChange: (event) => {
            setQuery((event.target as HTMLInputElement).value);
            setOpen(true);
            setActiveIndex(0);
          },
          onKeyDown: (event) => {
            if (event.key !== 'Enter' || activeIndex === null || shown[activeIndex] === undefined) return;
            event.preventDefault();
            choose(shown[activeIndex].id);
          },
          // Leaving the box closes the list. A click in the list keeps the focus in the box, so it is not a leave.
          onBlur: () => setOpenAndReset(false),
        })}
      />
      {/* The arrow shows that the box is a dropdown. A click on it goes through to the box, which opens the list. */}
      <span className="pointer-events-none absolute inset-y-0 right-1 flex items-center text-[var(--nim-text-muted)]" aria-hidden="true">
        <MaterialSymbol icon={open ? 'expand_less' : 'expand_more'} />
      </span>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="hook-picker-list z-[10001] overflow-auto rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] py-1 text-sm shadow"
            {...getFloatingProps()}
          >
            {shown.length === 0 && <div className="px-2 py-1 text-xs text-[var(--nim-text-faint)]">Nothing matches</div>}
            {shown.map((option, index) => (
              <div
                key={option.id}
                id={`${idPrefix}-${option.id}`}
                ref={(node) => {
                  listRef.current[index] = node;
                }}
                role="option"
                aria-selected={index === activeIndex}
                data-testid={`${testId}-option-${option.id}`}
                className={index === activeIndex ? 'cursor-pointer bg-[var(--nim-bg-hover)] px-2 py-1' : 'cursor-pointer px-2 py-1'}
                {...getItemProps({
                  onMouseDown: (event) => event.preventDefault(),
                  onClick: () => choose(option.id),
                })}
              >
                {option.name}
                {option.detail !== '' && <span className="block text-xs text-[var(--nim-text-faint)]">{option.detail}</span>}
              </div>
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
