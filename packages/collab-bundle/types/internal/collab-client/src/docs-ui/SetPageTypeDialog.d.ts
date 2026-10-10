/**
 * The type picker for "Set type" on a page: the section's own creatable types,
 * singular names, one click to convert. The resolver says which types take
 * new pages, so this bundle never reads the tracker registry.
 */
import React from 'react';
import type { CollabTypeTreeResolver } from '../docs/collabTree';
export interface SetPageTypeDialogProps {
    pageTitle: string;
    resolver: CollabTypeTreeResolver;
    running: boolean;
    onPick: (typeId: string) => void;
    onClose: () => void;
    /** Open "New type..." in this section; absent where the host cannot write a type. */
    onNewType?: () => void;
}
export declare function SetPageTypeDialog({ pageTitle, resolver, running, onPick, onClose, onNewType }: SetPageTypeDialogProps): React.ReactPortal;
