/**
 * The Trash row at the foot of a Pages section, and the Trash it opens. Every
 * delete in Pages (the tree, the agent's delete, the web console) moves a page
 * here; this is where a person gets it back. The dialog loads lazily, keeping
 * it out of the docs-ui eager bundle.
 */
import React, { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { listTrashEntries } from '../docs/collabTrash';
import { useCollabDocsUI } from './CollabDocsUIProvider';

const CollabTrashDialog = React.lazy(() => import('./CollabTrashDialog'));

export const CollabSidebarTrashEntry: React.FC<{ sectionLabel: string }> = ({ sectionLabel }) => {
  const { session } = useCollabDocsUI();
  const trashed = useAtomValue(session.atoms.trashedSharedDocuments);
  const count = useMemo(() => listTrashEntries(trashed).length, [trashed]);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="collab-sidebar-trash-entry shrink-0 flex items-center gap-2 mx-1.5 mb-1.5 px-2 py-1 rounded border-none bg-transparent cursor-pointer text-left text-[12px] text-[var(--nim-text-faint)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
        aria-label={`${sectionLabel} Trash${count > 0 ? `, ${count} item${count === 1 ? '' : 's'}` : ''}`}
        onClick={() => setOpen(true)}
      >
        <MaterialSymbol icon="delete" size={16} />
        <span className="flex-1">Trash</span>
        {count > 0 && <span className="collab-sidebar-trash-count text-[11px] tabular-nums">{count}</span>}
      </button>
      {open && (
        <React.Suspense fallback={null}>
          <CollabTrashDialog sectionLabel={sectionLabel} onClose={() => setOpen(false)} />
        </React.Suspense>
      )}
    </>
  );
};
