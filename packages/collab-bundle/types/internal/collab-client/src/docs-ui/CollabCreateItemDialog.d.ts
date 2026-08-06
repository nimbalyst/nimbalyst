import React from 'react';
import type { CollabDocumentTypeDescriptor } from '../core/index';
import { type SharedFolder } from '../docs/index';
export interface CollabCreateItemDialogProps {
    isOpen: boolean;
    kind: 'document' | 'folder';
    documentDescriptor?: CollabDocumentTypeDescriptor;
    folders: SharedFolder[];
    targetFolderId: string | null;
    onTargetFolderChange: (folderId: string | null) => void;
    onConfirm: (name: string) => void;
    onCancel: () => void;
}
export declare function CollabCreateItemDialog({ isOpen, kind, documentDescriptor, folders, targetFolderId, onTargetFolderChange, onConfirm, onCancel, }: CollabCreateItemDialogProps): React.JSX.Element | null;
