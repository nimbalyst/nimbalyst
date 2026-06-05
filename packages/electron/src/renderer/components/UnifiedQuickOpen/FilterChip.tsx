/**
 * FilterChip
 *
 * A chip-shaped trigger that opens a popover listing predefined options
 * (`options`) and a `history` of recently used values. Used by the unified
 * quick open dialog for both file-extension and tracker-type filters so they
 * feel the same.
 *
 * Modeled on the FileMaskFilter pattern in the git extension's GitLogPanel,
 * but factored out so multiple panes can share it.
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  useFloating,
  useDismiss,
  useInteractions,
  FloatingPortal,
  autoUpdate,
  offset,
  flip,
  shift,
} from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime';

export interface FilterChipOption {
  /** Stored / submitted value, e.g. ".ts" or "bug". */
  value: string;
  /** Display label, e.g. "TypeScript" or "Bug". */
  label: string;
  /** Optional Material icon for predefined options. */
  icon?: string;
  /** Optional color (hex or CSS var) for a leading dot. */
  color?: string;
}

interface FilterChipProps {
  /** Static label, shown when no value is set ("File ext", "Type"). */
  label: string;
  /** Currently selected value, or null when unfiltered. */
  value: string | null;
  /** Selection callback. Passing null clears the filter. */
  onChange: (value: string | null) => void;
  /** Predefined options (always shown). */
  options?: FilterChipOption[];
  /** Recently used custom values (shown below options). */
  history?: string[];
  /** Allow user to type a custom value. */
  freeText?: boolean;
  /** Placeholder for the free-text input. */
  placeholder?: string;
  /** Add a value to history (called when free-text is committed). */
  onAddToHistory?: (value: string) => void;
  /** Remove a value from history. */
  onRemoveFromHistory?: (value: string) => void;
  /** Optional label resolver — convert stored value to display label. */
  resolveLabel?: (value: string) => string;
}

export const FilterChip: React.FC<FilterChipProps> = ({
  label,
  value,
  onChange,
  options = [],
  history = [],
  freeText = false,
  placeholder = 'Filter...',
  onAddToHistory,
  onRemoveFromHistory,
  resolveLabel,
}) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  const dismiss = useDismiss(context, { escapeKey: true, outsidePress: true });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

  const matchedOption = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  );
  const displayValue = matchedOption?.label ?? (value ? (resolveLabel?.(value) ?? value) : null);

  const handlePick = useCallback(
    (next: string | null) => {
      onChange(next);
      setOpen(false);
      setDraft('');
    },
    [onChange],
  );

  const handleCommitDraft = useCallback(() => {
    const v = draft.trim();
    if (!v) return;
    onAddToHistory?.(v);
    handlePick(v);
  }, [draft, onAddToHistory, handlePick]);

  return (
    <>
      <button
        ref={refs.setReference}
        {...getReferenceProps()}
        type="button"
        className={`unified-quick-open-filter-chip inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded border cursor-pointer transition-colors duration-100 ${
          value
            ? 'bg-[rgba(0,122,255,0.12)] border-[var(--nim-primary)] text-[var(--nim-primary)]'
            : 'bg-nim-secondary border-nim text-nim-muted hover:text-nim hover:bg-nim-hover'
        }`}
        onClick={() => setOpen((o) => !o)}
        title={value ? `${label}: ${displayValue}` : label}
        tabIndex={-1}
      >
        <span className="font-medium">{label}:</span>
        <span className="truncate max-w-[140px]">{displayValue ?? 'Any'}</span>
        {value && (
          <span
            role="button"
            tabIndex={-1}
            className="ml-0.5 flex items-center justify-center w-3.5 h-3.5 rounded-full hover:bg-[rgba(0,122,255,0.25)]"
            onClick={(e) => {
              e.stopPropagation();
              handlePick(null);
            }}
            title="Clear filter"
          >
            <MaterialSymbol icon="close" size={10} />
          </span>
        )}
        {!value && <MaterialSymbol icon="expand_more" size={12} />}
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, zIndex: 100000 }}
            {...getFloatingProps()}
            className="unified-quick-open-filter-menu rounded-md border border-nim bg-nim shadow-[0_8px_24px_rgba(0,0,0,0.3)] min-w-[220px] max-h-[300px] overflow-y-auto p-1"
          >
            <button
              type="button"
              className="w-full text-left px-3 py-1.5 text-sm rounded cursor-pointer text-nim-muted hover:bg-nim-hover hover:text-nim"
              onClick={() => handlePick(null)}
            >
              Any
            </button>

            {options.length > 0 && (
              <>
                <MenuHeader>Options</MenuHeader>
                {options.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm rounded cursor-pointer ${
                      opt.value === value
                        ? 'bg-[rgba(0,122,255,0.15)] text-[var(--nim-primary)]'
                        : 'text-nim hover:bg-nim-hover'
                    }`}
                    onClick={() => handlePick(opt.value)}
                  >
                    {opt.color && (
                      <span
                        className="shrink-0 w-2 h-2 rounded-full"
                        style={{ backgroundColor: opt.color }}
                      />
                    )}
                    {opt.icon && (
                      <MaterialSymbol icon={opt.icon} size={14} className="shrink-0 text-nim-muted" />
                    )}
                    <span className="truncate flex-1">{opt.label}</span>
                    <span className="text-[10px] text-nim-faint">{opt.value}</span>
                  </button>
                ))}
              </>
            )}

            {history.length > 0 && (
              <>
                <MenuHeader>Recent</MenuHeader>
                {history.map((entry) => (
                  <div
                    key={entry}
                    className="group flex items-center rounded hover:bg-nim-hover"
                  >
                    <button
                      type="button"
                      className="flex-1 text-left px-3 py-1.5 text-sm cursor-pointer text-nim truncate"
                      onClick={() => handlePick(entry)}
                      title={entry}
                    >
                      {entry}
                    </button>
                    {onRemoveFromHistory && (
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 p-1 mr-1 rounded text-nim-faint hover:text-nim hover:bg-nim-tertiary cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveFromHistory(entry);
                        }}
                        title="Remove from history"
                      >
                        <MaterialSymbol icon="close" size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}

            {freeText && (
              <>
                <MenuHeader>Custom</MenuHeader>
                <div className="px-2 pb-1">
                  <input
                    type="text"
                    autoFocus
                    className="nim-input w-full text-sm py-1 px-2"
                    placeholder={placeholder}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleCommitDraft();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setOpen(false);
                      }
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </FloatingPortal>
      )}
    </>
  );
};

const MenuHeader: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-nim-faint">
    {children}
  </div>
);
