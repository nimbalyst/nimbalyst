import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { sessionListTitleAtom } from '../../store/atoms/sessions';
import { createNewSessionActionAtom } from '../../store/actions/sessionHistoryActions';

/**
 * Shown in place of the transcript when an empty workstream is selected. A
 * workstream is a container, so selecting it must never open it as a session.
 */
export function WorkstreamEmptyState({ workstreamId }: { workstreamId: string }) {
  const title = useAtomValue(sessionListTitleAtom(workstreamId));
  const createNewSession = useSetAtom(createNewSessionActionAtom);
  return (
    <div className="workstream-empty-state flex flex-col items-center justify-center h-full gap-3 text-[var(--nim-text-muted)]">
      <MaterialSymbol icon="folder_open" size={32} />
      <p className="m-0 text-sm select-text">{title || 'This workstream'} has no sessions yet.</p>
      <button
        onClick={() => void createNewSession({ launchSource: 'new_session_button', intoSelectedWorkstream: true })}
        className="workstream-empty-state-new py-2 px-4 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] cursor-pointer text-sm transition-colors hover:bg-[var(--nim-bg-hover)]"
      >
        New session in this workstream
      </button>
    </div>
  );
}
