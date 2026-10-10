import React, { useMemo } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { sessionRegistryAtom } from '../../store/atoms/sessions';
import { selectSessionActionAtom } from '../../store/actions/sessionHistoryActions';

/** Cross-container management remains navigable without implying a tree edge. */
export function SessionSpawnerLink({ sessionId }: { sessionId: string }) {
  const spawnerId = useAtomValue(
    useMemo(
      () =>
        atom((get) => {
          const rows = get(sessionRegistryAtom);
          const row = rows.get(sessionId);
          const manager = row?.createdBySessionId && rows.get(row.createdBySessionId);
          return row && manager && (row.worktreeId ?? null) !== (manager.worktreeId ?? null)
            ? manager.id
            : null;
        }),
      [sessionId]
    )
  );
  const title = useAtomValue(
    useMemo(
      () => atom((get) => (spawnerId ? get(sessionRegistryAtom).get(spawnerId)?.title : null)),
      [spawnerId]
    )
  );
  const select = useSetAtom(selectSessionActionAtom);
  return spawnerId ? (
    <div className="session-tree-from text-xs text-[var(--nim-text-muted)]">
      from{' '}
      <button
        className="underline"
        onClick={(e) => {
          e.stopPropagation();
          void select(spawnerId);
        }}
      >
        {title || 'session'}
      </button>
    </div>
  ) : null;
}
