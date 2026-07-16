import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { CollaborativeDocumentTypeDescriptor } from '../../services/CollaborativeDocumentTypeCatalog';

export interface SharedNewDocumentMenuItem {
  descriptor: CollaborativeDocumentTypeDescriptor;
  disabledReason?: string;
}

/**
 * Project the persistent local New menu types into Shared New. The catalog has
 * already discarded openVirtualTab contributions, so only descriptors with a
 * real creation payload can appear here.
 */
export function buildSharedNewDocumentMenuItems(
  descriptors: readonly CollaborativeDocumentTypeDescriptor[],
): SharedNewDocumentMenuItem[] {
  return descriptors
    .filter(descriptor => descriptor.capabilities.localCreate && descriptor.creation !== undefined)
    .map(descriptor => ({
      descriptor,
      ...(descriptor.capabilities.sharedCreate
        ? {}
        : {
            disabledReason: descriptor.capabilities.disabledReason
              ?? `${descriptor.displayName} is not ready for collaborative editing.`,
          }),
    }))
    .sort((left, right) => {
      const leftPinned = left.descriptor.documentType === 'markdown' ? 0 : 1;
      const rightPinned = right.descriptor.documentType === 'markdown' ? 0 : 1;
      return leftPinned - rightPinned
        || left.descriptor.displayName.localeCompare(right.descriptor.displayName)
        || left.descriptor.defaultExtension.localeCompare(right.descriptor.defaultExtension);
    });
}

interface CollabNewDocumentMenuProps {
  items: SharedNewDocumentMenuItem[];
  onSelect: (descriptor: CollaborativeDocumentTypeDescriptor) => void;
}

export function CollabNewDocumentMenu({ items, onSelect }: CollabNewDocumentMenuProps) {
  return (
    <div className="collab-new-document-menu min-w-[260px] max-w-[340px] rounded-md z-[10000] text-[13px] p-1 bg-nim-secondary border border-nim text-nim backdrop-blur-[10px] shadow-lg overflow-y-auto">
      {items.map(({ descriptor, disabledReason }) => {
        const disabled = disabledReason !== undefined;
        return (
          <button
            key={`${descriptor.documentType}:${descriptor.defaultExtension}:${descriptor.editor.extensionId ?? descriptor.editor.kind}`}
            type="button"
            role="menuitem"
            disabled={disabled}
            title={disabledReason}
            className="collab-new-document-menu-item w-full flex items-start gap-2.5 px-3 py-2 rounded border-none bg-transparent transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-55 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            onClick={() => onSelect(descriptor)}
          >
            <MaterialSymbol icon={descriptor.icon} size={18} className="shrink-0 mt-0.5" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-3">
                <span className="font-medium truncate">{descriptor.displayName}</span>
                <span className="text-[11px] text-nim-faint shrink-0">{descriptor.defaultExtension}</span>
              </span>
              {disabledReason && (
                <span className="block text-[11px] leading-snug text-nim-disabled mt-0.5">
                  {disabledReason}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
