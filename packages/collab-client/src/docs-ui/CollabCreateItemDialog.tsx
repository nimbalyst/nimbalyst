import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { CollabDocumentTypeDescriptor } from '@nimbalyst/collab-client/core';
import {
  flattenCollabFolderOptions,
  type CollabTreeNode,
  type SharedFolder,
  type SharedParentKind,
} from '@nimbalyst/collab-client/docs';
import { buildCollabTreeDestinations, type CollabTreeDestination } from './collabTreeDestinations';

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

const NO_DESCRIPTORS: readonly CollabDocumentTypeDescriptor[] = [];

/** First-class folders in the destination row shape. */
function folderDestinations(folders: SharedFolder[]): CollabTreeDestination[] {
  const options = flattenCollabFolderOptions(folders).filter(option => option.folderId !== null);
  const stack: string[] = [];
  return options.map((option, index) => {
    stack.length = option.depth;
    const ancestorKeys = stack.slice();
    stack[option.depth] = option.folderId!;
    return {
      key: option.folderId!,
      parentId: option.folderId,
      parentKind: 'page',
      name: option.name,
      depth: option.depth,
      icon: 'folder',
      expandedIcon: 'folder_open',
      selectable: true,
      ancestorKeys,
      hasChildren: (options[index + 1]?.depth ?? -1) > option.depth,
    };
  });
}

export function CollabCreateItemDialog({
  isOpen,
  kind,
  documentDescriptor,
  folders,
  tree,
  documentTypeDescriptors = NO_DESCRIPTORS,
  rootLabel = 'Team root',
  targetFolderId,
  targetParentKind = 'page',
  onTargetFolderChange,
  onConfirm,
  onCancel,
}: CollabCreateItemDialogProps) {
  const [name, setName] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const options = useMemo(() => {
    if (!isOpen) return [];
    return tree ? buildCollabTreeDestinations(tree, documentTypeDescriptors) : folderDestinations(folders);
  }, [documentTypeDescriptors, folders, isOpen, tree]);
  const selectedOption = targetFolderId === null
    ? null
    : options.find(option => option.selectable
      && option.parentId === targetFolderId
      && (!tree || option.parentKind === targetParentKind)) ?? null;
  const selectedKey = selectedOption?.key ?? null;
  // A tree still loading has no rows yet; keep the target until it arrives.
  const optionsReady = !tree || tree.length > 0;

  const documentDisplayName = documentDescriptor?.displayName ?? 'Document';
  const documentSuffix = documentDescriptor?.defaultExtension ?? '';
  const title = kind === 'folder' ? 'New Shared Folder' : `New Shared ${documentDisplayName}`;
  const itemLabel = kind === 'folder' ? 'folder' : 'document';
  const placeholder = kind === 'folder' ? 'Folder name' : `Untitled ${documentDisplayName}`;
  const itemIcon = kind === 'folder' ? 'create_new_folder' : documentDescriptor?.icon ?? 'note_add';
  const titleId = `collab-create-${kind}-title`;
  const nameInputId = `collab-create-${kind}-name`;
  const locationLabelId = `collab-create-${kind}-location-label`;

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    setName('');
    const expanded = new Set(selectedOption?.ancestorKeys ?? []);
    if (selectedOption) expanded.add(selectedOption.key);
    setExpandedKeys(expanded);
    inputRef.current?.focus();
  }, [isOpen, selectedOption]);

  useEffect(() => {
    if (isOpen && optionsReady && targetFolderId !== null && !selectedOption) {
      onTargetFolderChange(null, 'page');
    }
  }, [isOpen, onTargetFolderChange, optionsReady, selectedOption, targetFolderId]);

  if (!isOpen) return null;

  const toggleExpanded = (key: string) => {
    setExpandedKeys(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const nameByKey = new Map(options.map(option => [option.key, option.name]));
  const visibleOptions = options.filter(option => option.ancestorKeys.every(key => expandedKeys.has(key)));
  const destinationPath = selectedOption
    ? `${[...selectedOption.ancestorKeys, selectedOption.key].map(key => nameByKey.get(key)).filter(Boolean).join(' / ')} /`
    : `${rootLabel} /`;
  const selectOption = (option: CollabTreeDestination) => {
    if (option.selectable) onTargetFolderChange(option.parentId, option.parentKind);
    else if (option.hasChildren) toggleExpanded(option.key);
  };
  const renderRow = (
    rowKey: string,
    label: string,
    depthPx: number,
    isSelected: boolean,
    icon: React.ReactNode,
    extra: {
      option?: CollabTreeDestination;
      isExpanded?: boolean;
      onSelect: () => void;
    },
  ) => {
    const { option, isExpanded = false, onSelect } = extra;
    const disabled = option ? !option.selectable : false;
    return (
      <div
        key={rowKey}
        role="treeitem"
        aria-selected={isSelected}
        aria-disabled={disabled || undefined}
        aria-expanded={option?.hasChildren ? isExpanded : undefined}
        tabIndex={0}
        className={`collab-create-location-option relative flex items-center gap-1 px-2 py-1.5 rounded text-[13px] select-none ${
          disabled ? 'cursor-default' : 'cursor-pointer'
        } ${
          isSelected
            ? 'bg-[var(--nim-primary)]/20 text-[var(--nim-text)]'
            : disabled
              ? 'text-[var(--nim-text-faint)]'
              : 'text-[var(--nim-text)] hover:bg-[var(--nim-bg-tertiary)]'
        }`}
        style={{ paddingLeft: depthPx }}
        data-testid={`collab-create-location-option-${rowKey}`}
        onClick={onSelect}
        onDoubleClick={() => { if (option?.hasChildren) toggleExpanded(option.key); }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect();
          }
        }}
      >
        {isSelected && (
          <span aria-hidden className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-[var(--nim-primary)]" />
        )}
        {option && (
          <button
            type="button"
            className={`w-4 h-4 inline-flex items-center justify-center text-[var(--nim-text-faint)] ${
              option.hasChildren ? 'cursor-pointer' : 'cursor-default invisible'
            }`}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            onClick={event => {
              event.stopPropagation();
              if (option.hasChildren) toggleExpanded(option.key);
            }}
          >
            <MaterialSymbol icon={isExpanded ? 'expand_more' : 'chevron_right'} size={16} />
          </button>
        )}
        <span className={`inline-flex items-center justify-center ${
          isSelected ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
        }`}>
          {icon}
        </span>
        <span className="flex-1 truncate">{label}</span>
        {option?.hint ? (
          <span className="shrink-0 text-[11px] text-[var(--nim-text-faint)]">{option.hint}</span>
        ) : null}
      </div>
    );
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName) onConfirm(trimmedName);
  };

  return (
    <div
      className="collab-create-dialog-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-black/60"
      onClick={event => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div
        className="collab-create-dialog w-[460px] max-w-[92%] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-xl shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="collab-create-dialog"
        data-component="CollabCreateItemDialog"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => { if (event.key === 'Escape') onCancel(); }}
      >
        <div className="collab-create-dialog-header flex items-start gap-3 px-5 pt-4 pb-3 border-b border-[var(--nim-border)]">
          <div className="w-7 h-7 rounded-md bg-[var(--nim-primary)]/15 text-[var(--nim-primary)] flex items-center justify-center shrink-0 mt-0.5">
            <MaterialSymbol icon={itemIcon} size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="text-[14px] font-semibold text-[var(--nim-text)] m-0 leading-tight">
              {title}
            </h2>
            <p className="text-[12px] text-[var(--nim-text-faint)] m-0 mt-0.5 leading-snug">
              Pick where this {itemLabel} should live in your team space.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-tertiary)] w-6 h-6 rounded inline-flex items-center justify-center"
            aria-label="Close"
          >
            <MaterialSymbol icon="close" size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="collab-create-dialog-body px-5 pt-3 pb-2">
            <label
              id={`${nameInputId}-label`}
              htmlFor={nameInputId}
              className="block text-[11px] uppercase tracking-wider font-semibold text-[var(--nim-text-faint)] mb-1.5"
            >
              {kind === 'folder' ? 'Folder name' : `${documentDisplayName} name`}
            </label>
            <div className="flex items-center gap-1.5 px-2 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-subtle,var(--nim-border))] rounded-md mb-4 focus-within:border-[var(--nim-primary)]">
              <MaterialSymbol icon="edit" size={14} className="text-[var(--nim-text-faint)]" />
              <input
                ref={inputRef}
                id={nameInputId}
                type="text"
                className="collab-create-name-input flex-1 bg-transparent border-none text-[var(--nim-text)] text-[13px] py-2 outline-none font-inherit"
                placeholder={placeholder}
                value={name}
                data-testid="collab-create-name-input"
                onChange={event => {
                  const nextName = event.target.value;
                  if (
                    kind === 'document'
                    && documentSuffix
                    && nextName.toLowerCase().endsWith(documentSuffix.toLowerCase())
                  ) {
                    setName(nextName.slice(0, -documentSuffix.length));
                  } else {
                    setName(nextName);
                  }
                }}
              />
              {kind === 'document' && documentSuffix && (
                <span className="collab-create-name-suffix text-[12px] text-[var(--nim-text-muted)] pr-1 shrink-0">
                  {documentSuffix}
                </span>
              )}
            </div>

            <div
              id={locationLabelId}
              className="text-[11px] uppercase tracking-wider font-semibold text-[var(--nim-text-faint)] mb-1.5"
            >
              {tree ? 'Location' : 'Destination folder'}
            </div>
            <div
              className="collab-create-location-picker collab-create-location-options nim-scrollbar bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-subtle,var(--nim-border))] rounded-md p-1 mb-3 max-h-[240px] overflow-y-auto"
              data-testid="collab-create-location-picker"
              role="tree"
              aria-labelledby={locationLabelId}
            >
              {renderRow('root', rootLabel, 8, selectedKey === null, <MaterialSymbol icon="workspaces" size={18} />, {
                onSelect: () => onTargetFolderChange(null, 'page'),
              })}
              {visibleOptions.map(option => {
                const isExpanded = expandedKeys.has(option.key);
                return renderRow(
                  option.key,
                  option.name,
                  8 + option.depth * 18,
                  option.key === selectedKey,
                  <MaterialSymbol icon={isExpanded && option.expandedIcon ? option.expandedIcon : option.icon} size={18} />,
                  { option, isExpanded, onSelect: () => selectOption(option) },
                );
              })}
            </div>

            <div className="collab-create-destination-preview flex items-center gap-2 px-3 py-2 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-subtle,var(--nim-border))] rounded-md mb-3 text-[12px] text-[var(--nim-text-muted)]">
              <MaterialSymbol icon="place" size={14} className="text-[var(--nim-text-faint)]" />
              <span>Will be created as</span>
              <span className="text-[var(--nim-text)] font-medium truncate" title={destinationPath}>
                {destinationPath}
              </span>
              <span
                className="text-[var(--nim-primary)] truncate"
                title={`${name || placeholder}${kind === 'document' ? documentSuffix : ''}`}
              >
                {name || placeholder}{kind === 'document' ? documentSuffix : ''}
              </span>
            </div>
          </div>

          <div className="collab-create-dialog-footer flex justify-end gap-2 px-5 py-3 border-t border-[var(--nim-border)]">
            <button
              type="button"
              onClick={onCancel}
              className="collab-create-cancel px-3 py-1.5 bg-transparent rounded-md text-[var(--nim-text-muted)] text-[13px] hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`collab-create-confirm px-3.5 py-1.5 rounded-md text-[13px] font-medium inline-flex items-center gap-1.5 ${
                name.trim()
                  ? 'bg-[var(--nim-primary)] text-[#0f1115] hover:bg-[var(--nim-primary-hover)] hover:text-white cursor-pointer'
                  : 'bg-[var(--nim-primary)] text-[#0f1115] opacity-50 cursor-not-allowed'
              }`}
              disabled={!name.trim()}
            >
              <MaterialSymbol icon={itemIcon} size={16} />
              Create {kind === 'folder' ? 'Folder' : documentDisplayName}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
