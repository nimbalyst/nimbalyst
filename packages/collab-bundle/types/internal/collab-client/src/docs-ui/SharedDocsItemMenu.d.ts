/**
 * The context menu for a row in `SharedDocsListView`: a document or a folder.
 *
 * The folder tree (`CollabSidebar`) has carried these actions since shared
 * folders existed. A host that shows the list without the tree -- the browser
 * console, where folders are rows -- had no way to rename, move or trash
 * anything, so the actions live here too, against the same session calls and
 * the same name-collision rules the tree applies. The dual-write of a
 * document's path into its title is deliberate and matches the tree: clients
 * that predate first-class folders still build their tree from the title.
 */
import React from 'react';
import { type SharedDocument, type SharedFolder } from '../docs/index';
export type SharedDocsMenuTarget = {
    kind: 'document';
    document: SharedDocument;
} | {
    kind: 'folder';
    folder: SharedFolder;
};
/** Where the menu opens and for what. `null` closes it. */
export interface SharedDocsMenuState {
    x: number;
    y: number;
    target: SharedDocsMenuTarget;
}
export declare function SharedDocsItemMenu({ state, onClose, onOpenFolder, }: {
    state: SharedDocsMenuState | null;
    onClose: () => void;
    /**
     * How the host opens a folder. Only a host that browses folders in the list
     * shows folder rows, so a folder target without this falls back to the
     * host's artifact opener.
     */
    onOpenFolder?: (folderId: string) => void;
}): React.JSX.Element;
