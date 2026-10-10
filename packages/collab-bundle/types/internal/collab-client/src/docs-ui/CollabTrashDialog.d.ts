/**
 * A Pages section's Trash: each page sent there, who sent it and when, and
 * Restore. Restore brings back the pages that went with it; a page whose
 * parent is gone lands at the section root, and the dialog says so.
 *
 * There is no permanent delete here. Team Trash empties itself 30 days after a
 * page went in; Personal Trash keeps a page until it is restored.
 * Lazy-loaded by `CollabSidebarTrashEntry`.
 */
import React from 'react';
export interface CollabTrashDialogProps {
    /** The section's name ("Team", "Personal"), also the root a page may go back to. */
    sectionLabel: string;
    onClose: () => void;
}
export default function CollabTrashDialog({ sectionLabel, onClose }: CollabTrashDialogProps): React.JSX.Element;
