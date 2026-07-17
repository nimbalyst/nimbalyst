import type { JSX } from 'react';
import * as React from 'react';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { useAtomValue } from 'jotai';

import { trackerItemsArrayAtom } from '../TrackerPlugin/trackerDataAtoms';
import { buildTrackerReferenceOptions } from './trackerReferencePicker';
import { TrackerReferenceChip } from './TrackerReferenceChip';

export interface TrackerReferencePickerProps {
  /** Canonical issue keys or tracker ids persisted by the consumer. */
  value: readonly string[];
  onChange(value: string[]): void;
  /** Defaults to true. Single selection replaces the current value. */
  multiple?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  maxResults?: number;
}

/**
 * Host-owned tracker selector for extensions and runtime editors.
 *
 * Consumers persist only the returned reference keys. Candidate lookup and
 * rendered chips remain connected to the canonical runtime tracker store.
 */
export function TrackerReferencePicker({
  value,
  onChange,
  multiple = true,
  disabled = false,
  placeholder = 'Link tracker item',
  className,
  maxResults = 25,
}: TrackerReferencePickerProps): JSX.Element {
  const trackerItems = useAtomValue(trackerItemsArrayAtom);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange(nextOpen) {
      if (!disabled) setOpen(nextOpen);
      if (!nextOpen) setQuery('');
    },
    placement: 'bottom-start',
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ rects, elements, availableHeight, availableWidth }) {
          const width = Math.max(
            rects.reference.width,
            Math.min(420, Math.max(280, availableWidth)),
          );
          Object.assign(elements.floating.style, {
            width: `${width}px`,
            maxWidth: 'calc(100vw - 16px)',
            maxHeight: `${Math.max(160, Math.min(360, availableHeight))}px`,
          });
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });
  const click = useClick(context, { enabled: !disabled });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'listbox' });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const selected = React.useMemo(() => new Set(value), [value]);
  const options = React.useMemo(
    () => buildTrackerReferenceOptions(trackerItems, query, { limit: maxResults })
      .filter(option => !selected.has(option.referenceKey)),
    [maxResults, query, selected, trackerItems],
  );

  const selectReference = React.useCallback((referenceKey: string) => {
    if (disabled) return;
    onChange(multiple ? [...value, referenceKey] : [referenceKey]);
    setQuery('');
    if (!multiple) setOpen(false);
  }, [disabled, multiple, onChange, value]);

  const removeReference = React.useCallback((referenceKey: string) => {
    if (disabled) return;
    onChange(value.filter(key => key !== referenceKey));
  }, [disabled, onChange, value]);

  return (
    <div className={['tracker-reference-picker', className].filter(Boolean).join(' ')}>
      {value.length > 0 ? (
        <div
          className="tracker-reference-picker-values"
          style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '6px' }}
        >
          {value.map(referenceKey => (
            <span
              key={referenceKey}
              className="tracker-reference-picker-value"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '2px' }}
            >
              <TrackerReferenceChip referenceKey={referenceKey} variant="compact" />
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove tracker reference ${referenceKey}`}
                  onClick={() => removeReference(referenceKey)}
                  style={{
                    border: 0,
                    padding: '1px 3px',
                    color: 'var(--nim-text-muted)',
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      <button
        ref={refs.setReference}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        {...getReferenceProps()}
        aria-label={placeholder}
        className="tracker-reference-picker-trigger"
        style={{
          width: '100%',
          minHeight: '30px',
          padding: '5px 8px',
          borderRadius: '6px',
          border: '1px solid var(--nim-border)',
          background: 'var(--nim-bg-secondary)',
          color: disabled ? 'var(--nim-text-faint)' : 'var(--nim-text)',
          textAlign: 'left',
          cursor: disabled ? 'default' : 'pointer',
        }}
      >
        {placeholder}
      </button>

      {open ? (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            {...getFloatingProps()}
            style={{
              ...floatingStyles,
              zIndex: 1000,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              borderRadius: '8px',
              border: '1px solid var(--nim-border)',
              background: 'var(--nim-bg)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            }}
            className="tracker-reference-picker-popover"
          >
            <input
              autoFocus
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search tracker items…"
              aria-label="Search tracker items"
              style={{
                margin: '8px',
                padding: '6px 8px',
                borderRadius: '6px',
                border: '1px solid var(--nim-border)',
                background: 'var(--nim-bg-secondary)',
                color: 'var(--nim-text)',
              }}
            />
            <div style={{ overflowY: 'auto', padding: '0 4px 4px' }}>
              {options.length > 0 ? options.map(option => {
                const label = option.issueKey ?? option.referenceKey;
                const meta = [option.type, option.status].filter(Boolean).join(' · ');
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => selectReference(option.referenceKey)}
                    className="tracker-reference-picker-option"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '3px',
                      width: '100%',
                      minWidth: 0,
                      padding: '7px 8px',
                      border: 0,
                      borderRadius: '5px',
                      background: 'transparent',
                      color: 'var(--nim-text)',
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      className="tracker-reference-picker-option-title"
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: '12px',
                        fontWeight: 550,
                      }}
                    >
                      {option.title || label}
                    </span>
                    <span
                      className="tracker-reference-picker-option-meta"
                      title={[label, meta].filter(Boolean).join(' · ')}
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: 'var(--nim-text-faint)',
                        fontSize: '10px',
                      }}
                    >
                      {[label, meta].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                );
              }) : (
                <div
                  className="tracker-reference-picker-empty"
                  style={{ padding: '12px', color: 'var(--nim-text-muted)', fontSize: '12px' }}
                >
                  {query ? `No tracker items match “${query}”` : 'No tracker items available'}
                </div>
              )}
            </div>
          </div>
        </FloatingPortal>
      ) : null}
    </div>
  );
}
