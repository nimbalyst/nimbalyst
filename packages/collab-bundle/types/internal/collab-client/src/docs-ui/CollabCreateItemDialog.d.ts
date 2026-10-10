import React from 'react';
import type { CollabDocumentTypeDescriptor } from '../core/index';
import { type CollabTreeNode, type SharedFolder, type SharedParentKind } from '../docs/index';
export interface CollabCreateItemDialogProps {
    isOpen: boolean;
    kind: 'document' | 'folder';
    documentDescriptor?: CollabDocumentTypeDescriptor;
    folders: SharedFolder[];
    /**
     * The sidebar page tree. When set, the picker mirrors it (pages, typed
     * pages, types) instead of listing `folders`.
     */
    tree?: CollabTreeNode[];
    /** Resolves page icons when `tree` is set. */
    documentTypeDescriptors?: readonly CollabDocumentTypeDescriptor[];
    rootLabel?: string;
    targetFolderId: string | null;
    /** With `tree`: whether `targetFolderId` is a page or a typed page. */
    targetParentKind?: SharedParentKind;
    onTargetFolderChange: (folderId: string | null, parentKind?: SharedParentKind) => void;
    onConfirm: (name: string) => void;
    onCancel: () => void;
}
export declare function CollabCreateItemDialog({ isOpen, kind, documentDescriptor, folders, tree, documentTypeDescriptors, rootLabel, targetFolderId, targetParentKind, onTargetFolderChange, onConfirm, onCancel, }: CollabCreateItemDialogProps): React.JSX.Element | null;
