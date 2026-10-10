/**
 * The "where in the team space does this go" panel.
 *
 * Two surfaces promote local content to the team now -- one file, or a whole
 * folder -- and they ask the same destination question with the same rows, the
 * same refresh gate, and the same eager folder creation. This is that shared
 * half, so adding folder promote did not fork the picker.
 *
 * Deliberately NOT here: which folder starts selected. That is policy and it
 * differs per surface (last-used, caller-supplied, or the folder being
 * promoted), so it stays with the dialog that has an opinion about it.
 *
 * `FeedbackDestinationDialog` still owns its own copy on purpose: it must NOT
 * create a folder eagerly, because the author has not committed to sending yet.
 */

import React, { useCallback, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { activeCollabScopeAtom, createSharedFolder, getPersonalCollabDocsSession } from '../../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { normalizeCollabPath } from '../CollabMode/collabTree';
import { SharedFolderTree } from './SharedFolderTree';
import type { SharedFolderSection, SharedFolderTreeState } from './useSharedFolderTree';

export interface SharedFolderPickerPanelProps {
  folderTree: SharedFolderTreeState;
  selectedFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  /** Folder to badge as "last used", when the surface tracks one. */
  highlightFolderId?: string | null;
  /** Blocks folder creation until the surface has seeded its selection. */
  canCreateFolder: boolean;
  /** The Pages section the tree lists; a new page is created there. Defaults to Team. */
  section?: SharedFolderSection;
}

export function SharedFolderPickerPanel({
  folderTree,
  selectedFolderId,
  onSelectFolder,
  highlightFolderId,
  canCreateFolder,
  section = 'team',
}: SharedFolderPickerPanelProps) {
  const collabScope = useAtomValue(activeCollabScopeAtom);
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  const rootLabel = section === 'personal' ? 'Top of Personal' : 'Top of Team';
  const {
    isRefreshing,
    refreshFailed,
    expandedFolders,
    toggleFolder,
    expandFolder,
    pathById,
    idByPath,
  } = folderTree;

  const [newFolderParentId, setNewFolderParentId] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState('');

  const beginNewFolder = useCallback((parentFolderId: string | null) => {
    setNewFolderParentId(parentFolderId);
    setNewFolderName('');
    if (parentFolderId) expandFolder(parentFolderId);
  }, [expandFolder]);

  const cancelNewFolder = useCallback(() => {
    setNewFolderParentId(undefined);
    setNewFolderName('');
  }, []);

  // New folders are first-class TeamRoom rows immediately, never local path
  // drafts that can leak into a later dialog open.
  const commitNewFolder = useCallback(async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      cancelNewFolder();
      return;
    }
    // Folder names are single segments; reject path separators.
    if (trimmed.includes('/') || trimmed.includes('\\')) return;

    const parentFolderId = newFolderParentId ?? null;
    const parentPath = parentFolderId ? (pathById.get(parentFolderId) ?? '') : '';
    const fullPath = normalizeCollabPath(parentPath ? `${parentPath}/${trimmed}` : trimmed);
    const existingFolderId = idByPath.get(fullPath);
    cancelNewFolder();
    if (existingFolderId) {
      onSelectFolder(existingFolderId);
      return;
    }
    try {
      let folderId: string;
      if (section === 'personal') {
        if (!workspacePath) return;
        folderId = await getPersonalCollabDocsSession(workspacePath).createFolder(trimmed, parentFolderId);
      } else {
        if (!collabScope) return;
        folderId = await createSharedFolder(collabScope, trimmed, parentFolderId);
      }
      onSelectFolder(folderId);
      expandFolder(folderId);
      if (parentFolderId) expandFolder(parentFolderId);
    } catch (error) {
      console.error('[SharedFolderPickerPanel] Failed to create shared folder:', error);
    }
  }, [cancelNewFolder, collabScope, expandFolder, idByPath, newFolderName, newFolderParentId, onSelectFolder, pathById, section, workspacePath]);

  const isRootCreateOpen = newFolderParentId === null;

  return (
    <div className="shared-folder-picker-panel">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--nim-text-faint)]">
          Inside
        </div>
        <button
          type="button"
          onClick={() => beginNewFolder(selectedFolderId)}
          disabled={isRefreshing || refreshFailed || !canCreateFolder}
          className="text-[11px] text-[var(--nim-primary)] hover:underline inline-flex items-center gap-1 disabled:opacity-50 disabled:no-underline"
        >
          <MaterialSymbol icon="note_add" size={13} />
          New page
        </button>
      </div>
      <div className="share-to-team-tree bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-subtle,var(--nim-border))] rounded-md p-1 mb-3 max-h-[240px] overflow-y-auto">
        {isRefreshing ? (
          <div className="flex items-center justify-center gap-2 px-3 py-6 text-[12px] text-[var(--nim-text-muted)]">
            <MaterialSymbol icon="progress_activity" size={16} className="animate-spin" />
            Refreshing pages…
          </div>
        ) : refreshFailed ? (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--nim-text-muted)]">
            The wiki could not be refreshed. Close this dialog and try again.
          </div>
        ) : (
          <>
            {/* Section root row */}
            <div
              role="treeitem"
              aria-selected={selectedFolderId === null}
              tabIndex={0}
              onClick={() => onSelectFolder(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectFolder(null);
                }
              }}
              className={`relative flex items-center gap-1 px-2 py-1.5 rounded text-[13px] cursor-pointer select-none ${
                selectedFolderId === null
                  ? 'bg-[var(--nim-primary)]/20 text-[var(--nim-text)]'
                  : 'text-[var(--nim-text)] hover:bg-[var(--nim-bg-tertiary)]'
              }`}
              style={{ paddingLeft: 8 }}
            >
              {selectedFolderId === null && (
                <span aria-hidden className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-[var(--nim-primary)]" />
              )}
              <span className="w-4 h-4 inline-flex items-center justify-center text-[var(--nim-text-faint)] invisible">
                <MaterialSymbol icon="chevron_right" size={16} />
              </span>
              <span className={`inline-flex items-center justify-center ${selectedFolderId === null ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'}`}>
                <MaterialSymbol icon="workspaces" size={18} />
              </span>
              <span className="flex-1 truncate">{rootLabel}</span>
              {highlightFolderId === null && (
                <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-[var(--nim-primary)]/15 text-[var(--nim-primary)]">
                  last used
                </span>
              )}
            </div>

            <SharedFolderTree
              nodes={folderTree.tree}
              selectedFolderId={selectedFolderId}
              onSelect={onSelectFolder}
              expandedFolders={expandedFolders}
              onToggleFolder={toggleFolder}
              highlightFolderId={highlightFolderId}
              newFolderParentId={newFolderParentId}
              newFolderName={newFolderName}
              onNewFolderNameChange={setNewFolderName}
              onCommitNewFolder={() => { void commitNewFolder(); }}
              onCancelNewFolder={cancelNewFolder}
            />

            {/* Inline new-folder input at root level */}
            {isRootCreateOpen && (
              <div className="flex items-center gap-2 py-1 px-2">
                <MaterialSymbol icon="create_new_folder" size={14} className="text-[var(--nim-primary)]" />
                <input
                  autoFocus
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitNewFolder();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelNewFolder();
                    }
                  }}
                  onBlur={() => { void commitNewFolder(); }}
                  placeholder="Page name"
                  className="flex-1 bg-[var(--nim-bg)] border border-[var(--nim-primary)] rounded text-[13px] text-[var(--nim-text)] px-2 py-1 outline-none"
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
