import React from 'react';
import type { CollabDocumentTypeDescriptor } from '../core/index';
export interface SharedNewDocumentMenuItem {
    descriptor: CollabDocumentTypeDescriptor;
}
/**
 * Project the persistent local New menu types into Shared New. The catalog has
 * already discarded openVirtualTab contributions, so only descriptors with a
 * real creation payload can appear here.
 */
export declare function buildSharedNewDocumentMenuItems(descriptors: readonly CollabDocumentTypeDescriptor[]): SharedNewDocumentMenuItem[];
export interface CollabNewDocumentMenuProps {
    items: SharedNewDocumentMenuItem[];
    onSelect: (descriptor: CollabDocumentTypeDescriptor) => void;
}
export declare function CollabNewDocumentMenu({ items, onSelect }: CollabNewDocumentMenuProps): React.JSX.Element;
