import React, { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import {
  FloatingFocusManager,
  offset,
  flip,
  shift,
  autoUpdate,
  FloatingPortal,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { sessionRegistryAtom } from '../../store/atoms/sessions';
import { isWorkstreamContainer, sessionMoveError } from './sessionTreeModel';

const NEW_WORKSTREAM = '\0new-workstream';

export function SessionMovePicker({
  sessionId,
  onMove,
  onClose,
  mode = 'parent',
  onCreateWorkstream,
}: {
  sessionId: string;
  onMove: (parentId: string) => Promise<boolean>;
  onClose: () => void;
  /** `workstreams` lists only workstream containers, for "Move to workstream...". */
  mode?: 'parent' | 'workstreams';
  /** Workstream mode: create a workstream (named by the search text, if any) and move into it. */
  onCreateWorkstream?: (title: string) => Promise<boolean>;
}) {
  const registry = useAtomValue(sessionRegistryAtom);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [pending, setPending] = useState(false);
  const workstreams = mode === 'workstreams';
  const candidates = useMemo(() => {
    const rows: { id: string; title: string }[] = [...registry.values()].filter(
      (row) =>
        !row.isArchived &&
        (!workstreams || isWorkstreamContainer(row)) &&
        row.id !== registry.get(sessionId)?.parentSessionId &&
        !sessionMoveError(registry, sessionId, row.id) &&
        row.title.toLowerCase().includes(query.toLowerCase())
    );
    return workstreams && onCreateWorkstream
      ? [{ id: NEW_WORKSTREAM, title: query.trim() ? `New workstream "${query.trim()}"` : 'New workstream...' }, ...rows]
      : rows;
  }, [registry, sessionId, query, workstreams, onCreateWorkstream]);
  const { refs, context, floatingStyles } = useFloating({
    elements: { reference: document.getElementById(`session-list-item-${sessionId}`) },
    placement: 'right-start',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
    open: true,
    onOpenChange: (open) => {
      if (!open && !pending) onClose();
    },
  });
  const { getFloatingProps } = useInteractions([useDismiss(context), useRole(context, { role: 'dialog' })]);
  const choose = async (id: string) => {
    setPending(true);
    try {
      const done = id === NEW_WORKSTREAM ? await onCreateWorkstream!(query.trim()) : await onMove(id);
      if (done) onClose();
    } finally {
      setPending(false);
    }
  };
  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} modal={false}>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          {...getFloatingProps({
            onClick: (e: React.MouseEvent) => e.stopPropagation(),
            onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
          })}
          aria-label={workstreams ? 'Move session to workstream' : 'Move session under'}
          className="session-move-picker z-[2000] w-96 max-w-[90vw] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] p-3 shadow-xl"
        >
          <input
            autoFocus
            aria-label={workstreams ? 'Search workstreams' : 'Search parent sessions'}
            placeholder={workstreams ? 'Search workstreams…' : 'Search sessions…'}
            value={query}
            disabled={pending}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) =>
                  Math.max(0, Math.min(candidates.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))
                );
              }
              if (e.key === 'Enter' && candidates[index] && !pending) {
                e.preventDefault();
                void choose(candidates[index].id);
              }
            }}
            aria-controls="session-move-options"
            aria-activedescendant={candidates[index] ? `move-option-${candidates[index].id}` : undefined}
            className="session-move-picker-search w-full bg-[var(--nim-bg-secondary)] p-2 rounded outline-none"
          />
          <div
            id="session-move-options"
            role="listbox"
            aria-label={workstreams ? 'Available workstreams' : 'Available parents'}
            className="session-move-picker-results max-h-72 overflow-auto mt-2"
          >
            {candidates.map((row, i) => (
              <button
                key={row.id}
                id={`move-option-${row.id}`}
                role="option"
                aria-selected={i === index}
                disabled={pending}
                onClick={() => void choose(row.id)}
                className={`session-move-picker-option block w-full text-left p-2 rounded ${
                  i === index ? 'bg-[var(--nim-bg-selected)]' : ''
                }`}
              >
                {row.title || (workstreams ? 'Untitled Workstream' : 'Untitled Session')}
              </button>
            ))}
            {!candidates.length && (
              <p className="p-2 text-[var(--nim-text-muted)]">{workstreams ? 'No matching workstreams' : 'No matching parent sessions'}</p>
            )}
          </div>
          <button onClick={onClose} disabled={pending} className="mt-2 px-2 py-1">
            Cancel
          </button>
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}
