import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  createSharedFolder,
  refreshSharedFolders,
  sharedFoldersAtom,
  type SharedFolder,
} from '../../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import {
  flattenCollabFolderOptions,
  normalizeCollabPath,
} from '../CollabMode/collabTree';
import type { CollaborativeDocumentTypeDescriptor } from '../../services/CollaborativeDocumentTypeCatalog';

export interface ShareToTeamDialogProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  descriptor: CollaborativeDocumentTypeDescriptor;
  /** Workspace-relative path used as the source label in the dialog. */
  sourceRelPath: string;
  /**
   * Called when the user confirms. Returns the selected destination folder
   * (empty string = team root) and the shared name (with extension).
   */
  onConfirm: (params: { folderId: string | null; folderPath: string; sharedName: string }) => void;
}

export interface ShareFolderNode {
  folderId: string;
  path: string;
  name: string;
  depth: number;
  children: ShareFolderNode[];
}

export function splitShareFileName(
  fileName: string,
  descriptor: CollaborativeDocumentTypeDescriptor,
): { baseName: string; suffix: string } {
  const lowerName = fileName.toLowerCase();
  const matchedSuffix = [...descriptor.fileExtensions]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .find(suffix => lowerName.endsWith(suffix.toLowerCase()));
  const suffix = matchedSuffix
    ? fileName.slice(fileName.length - matchedSuffix.length)
    : descriptor.defaultExtension;
  const baseName = matchedSuffix ? fileName.slice(0, -matchedSuffix.length) : fileName;
  return { baseName, suffix };
}

/** Build the picker tree from authoritative first-class folder rows. */
export function buildShareFolderTree(folders: SharedFolder[]): ShareFolderNode[] {
  const options = flattenCollabFolderOptions(folders).filter(option => option.folderId !== null);
  const roots: ShareFolderNode[] = [];
  const stack: ShareFolderNode[] = [];
  const pathSegments: string[] = [];

  for (const option of options) {
    const folderId = option.folderId as string;
    stack.length = option.depth;
    pathSegments.length = option.depth;
    pathSegments[option.depth] = option.name;
    const node: ShareFolderNode = {
      folderId,
      path: normalizeCollabPath(pathSegments.join('/')),
      name: option.name,
      depth: option.depth,
      children: [],
    };
    const parent = option.depth > 0 ? stack[option.depth - 1] : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack[option.depth] = node;
  }
  return roots;
}

export function ShareToTeamDialog({
  isOpen,
  onClose,
  fileName,
  descriptor,
  sourceRelPath,
  onConfirm,
}: ShareToTeamDialogProps) {
  const sharedFolders = useAtomValue(sharedFoldersAtom);
  const workspacePath = useAtomValue(activeWorkspacePathAtom);

  const [lastSharedFolderId, setLastSharedFolderId] = useState<string | null | undefined>(undefined);
  const [legacyLastSharedFolderPath, setLegacyLastSharedFolderPath] = useState<string>('');
  const [hasLastSharedFolder, setHasLastSharedFolder] = useState(false);
  const [hasLoadedState, setHasLoadedState] = useState(false);
  const [isRefreshingFolders, setIsRefreshingFolders] = useState(false);
  const [folderRefreshFailed, setFolderRefreshFailed] = useState(false);
  const [hasInitializedSelection, setHasInitializedSelection] = useState(false);

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const fileNameParts = useMemo(
    () => splitShareFileName(fileName, descriptor),
    [descriptor, fileName],
  );
  const [sharedBaseName, setSharedBaseName] = useState<string>(fileNameParts.baseName);
  const [newFolderParentId, setNewFolderParentId] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState<string>('');

  // Reset transient state every time the dialog opens for a different file.
  useEffect(() => {
    if (!isOpen) return;
    setSharedBaseName(fileNameParts.baseName);
    setNewFolderParentId(undefined);
    setNewFolderName('');
    setHasInitializedSelection(false);
  }, [fileNameParts.baseName, isOpen]);

  // Every open asks TeamRoom for a current folder-index snapshot. While that
  // round trip is pending, do not paint the previously cached tree.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setIsRefreshingFolders(true);
    setFolderRefreshFailed(false);
    void refreshSharedFolders(workspacePath ?? undefined)
      .then((refreshed) => {
        if (!cancelled && !refreshed) setFolderRefreshFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFolderRefreshFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIsRefreshingFolders(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, workspacePath]);

  // Load workspace-persisted state for the last-used destination. Folder rows
  // themselves come only from TeamRoom, never workspace/PGLite state.
  useEffect(() => {
    if (!isOpen) return;
    setHasLoadedState(false);
    if (!workspacePath || !window.electronAPI?.invoke) {
      setHasLoadedState(true);
      return;
    }
    let cancelled = false;
    window.electronAPI.invoke('workspace:get-state', workspacePath)
      .then((state: any) => {
        if (cancelled) return;
        const collabTree = state?.collabTree;
        const hasPersistedId = Boolean(
          collabTree && Object.prototype.hasOwnProperty.call(collabTree, 'lastSharedFolderId'),
        );
        const hasPersistedPath = typeof collabTree?.lastSharedFolder === 'string';
        const persistedId = typeof collabTree?.lastSharedFolderId === 'string'
          ? collabTree.lastSharedFolderId
          : null;
        const persistedPath = hasPersistedPath
          ? normalizeCollabPath(collabTree.lastSharedFolder)
          : '';
        setLastSharedFolderId(hasPersistedId ? persistedId : undefined);
        setLegacyLastSharedFolderPath(persistedPath);
        setHasLastSharedFolder(hasPersistedId || hasPersistedPath);
        setHasLoadedState(true);
      })
      .catch(() => {
        if (cancelled) return;
        setHasLastSharedFolder(false);
        setHasLoadedState(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, workspacePath]);

  const folderTree = useMemo(
    () => buildShareFolderTree(sharedFolders),
    [sharedFolders],
  );

  const folderLookups = useMemo(() => {
    const ids = new Set<string>();
    const pathById = new Map<string, string>();
    const idByPath = new Map<string, string>();
    const walk = (nodes: ShareFolderNode[]) => {
      for (const node of nodes) {
        ids.add(node.folderId);
        pathById.set(node.folderId, node.path);
        idByPath.set(node.path, node.folderId);
        walk(node.children);
      }
    };
    walk(folderTree);
    return { ids, pathById, idByPath };
  }, [folderTree]);

  const resolvedLastSharedFolderId = useMemo<string | null | undefined>(() => {
    if (!hasLastSharedFolder) return undefined;
    if (lastSharedFolderId !== undefined) {
      return lastSharedFolderId && folderLookups.ids.has(lastSharedFolderId)
        ? lastSharedFolderId
        : null;
    }
    return legacyLastSharedFolderPath
      ? (folderLookups.idByPath.get(legacyLastSharedFolderPath) ?? null)
      : null;
  }, [folderLookups, hasLastSharedFolder, lastSharedFolderId, legacyLastSharedFolderPath]);

  // After both local preference state and the authoritative refresh finish,
  // seed selection exactly once for this open.
  useEffect(() => {
    if (
      !isOpen
      || !hasLoadedState
      || isRefreshingFolders
      || folderRefreshFailed
      || hasInitializedSelection
    ) return;
    const candidate = resolvedLastSharedFolderId ?? null;
    setSelectedFolderId(candidate);
    const expanded = new Set<string>();
    let cursor = candidate ? sharedFolders.find(folder => folder.folderId === candidate) : undefined;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.folderId)) {
      seen.add(cursor.folderId);
      expanded.add(cursor.folderId);
      cursor = cursor.parentFolderId
        ? sharedFolders.find(folder => folder.folderId === cursor!.parentFolderId)
        : undefined;
    }
    setExpandedFolders(expanded);
    setHasInitializedSelection(true);
  }, [
    hasInitializedSelection,
    hasLoadedState,
    folderRefreshFailed,
    isOpen,
    isRefreshingFolders,
    resolvedLastSharedFolderId,
    sharedFolders,
  ]);

  useEffect(() => {
    if (hasInitializedSelection && selectedFolderId && !folderLookups.ids.has(selectedFolderId)) {
      setSelectedFolderId(null);
    }
  }, [folderLookups, hasInitializedSelection, selectedFolderId]);

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  // New folders are first-class TeamRoom rows immediately, never local path
  // drafts that can leak into a later dialog open.
  const beginNewFolder = useCallback((parentFolderId: string | null) => {
    setNewFolderParentId(parentFolderId);
    setNewFolderName('');
    if (parentFolderId) {
      setExpandedFolders(prev => {
        const next = new Set(prev);
        next.add(parentFolderId);
        return next;
      });
    }
  }, []);

  const commitNewFolder = useCallback(async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setNewFolderParentId(undefined);
      setNewFolderName('');
      return;
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      // Reject path separators; folder names are single segments.
      return;
    }
    const parentFolderId = newFolderParentId ?? null;
    const parentPath = parentFolderId ? (folderLookups.pathById.get(parentFolderId) ?? '') : '';
    const fullPath = normalizeCollabPath(parentPath ? `${parentPath}/${trimmed}` : trimmed);
    const existingFolderId = folderLookups.idByPath.get(fullPath);
    setNewFolderParentId(undefined);
    setNewFolderName('');
    if (existingFolderId) {
      setSelectedFolderId(existingFolderId);
      return;
    }
    try {
      const folderId = await createSharedFolder(trimmed, parentFolderId);
      setSelectedFolderId(folderId);
      setExpandedFolders(prev => {
        const next = new Set(prev);
        next.add(folderId);
        if (parentFolderId) next.add(parentFolderId);
        return next;
      });
    } catch (error) {
      console.error('[ShareToTeamDialog] Failed to create shared folder:', error);
    }
  }, [folderLookups, newFolderName, newFolderParentId]);

  const cancelNewFolder = useCallback(() => {
    setNewFolderParentId(undefined);
    setNewFolderName('');
  }, []);

  const handleConfirm = useCallback(() => {
    const trimmedName = sharedBaseName.trim();
    if (
      !trimmedName
      || isRefreshingFolders
      || folderRefreshFailed
      || !hasInitializedSelection
    ) return;
    onConfirm({
      folderId: selectedFolderId,
      folderPath: selectedFolderId ? (folderLookups.pathById.get(selectedFolderId) ?? '') : '',
      sharedName: `${trimmedName}${fileNameParts.suffix}`,
    });
    onClose();
  }, [
    folderLookups,
    folderRefreshFailed,
    hasInitializedSelection,
    isRefreshingFolders,
    onClose,
    onConfirm,
    selectedFolderId,
    fileNameParts.suffix,
    sharedBaseName,
  ]);

  if (!isOpen) return null;

  const renderFolderRow = (node: ShareFolderNode) => {
    const isExpanded = expandedFolders.has(node.folderId);
    const isSelected = selectedFolderId === node.folderId;
    const isLastUsed = resolvedLastSharedFolderId === node.folderId;
    const hasChildren = node.children.length > 0;
    const showInlineNewFolder = newFolderParentId === node.folderId;
    const depthPx = 8 + node.depth * 18;

    return (
      <React.Fragment key={node.folderId}>
        <div
          role="treeitem"
          aria-selected={isSelected}
          tabIndex={0}
          onClick={() => setSelectedFolderId(node.folderId)}
          onDoubleClick={() => toggleFolder(node.folderId)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setSelectedFolderId(node.folderId);
            }
          }}
          className={`relative flex items-center gap-1 px-2 py-1.5 rounded text-[13px] cursor-pointer select-none ${
            isSelected
              ? 'bg-[var(--nim-primary)]/20 text-[var(--nim-text)]'
              : 'text-[var(--nim-text)] hover:bg-[var(--nim-bg-tertiary)]'
          }`}
          style={{ paddingLeft: depthPx }}
        >
          {isSelected && (
            <span
              aria-hidden
              className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-[var(--nim-primary)]"
            />
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (hasChildren) toggleFolder(node.folderId);
            }}
            className={`w-4 h-4 inline-flex items-center justify-center text-[var(--nim-text-faint)] ${
              hasChildren ? 'cursor-pointer' : 'cursor-default invisible'
            }`}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            <MaterialSymbol icon={isExpanded ? 'expand_more' : 'chevron_right'} size={16} />
          </button>
          <span
            className={`inline-flex items-center justify-center ${
              isSelected ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'
            }`}
          >
            <MaterialSymbol icon={isExpanded ? 'folder_open' : 'folder'} size={18} />
          </span>
          <span className="flex-1 truncate">{node.name}</span>
          {isLastUsed && (
            <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-[var(--nim-primary)]/15 text-[var(--nim-primary)]">
              last used
            </span>
          )}
        </div>
        {showInlineNewFolder && (
          <div
            className="flex items-center gap-2 py-1"
            style={{ paddingLeft: depthPx + 18 }}
          >
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
              placeholder="Folder name"
              className="flex-1 bg-[var(--nim-bg)] border border-[var(--nim-primary)] rounded text-[13px] text-[var(--nim-text)] px-2 py-1 outline-none"
            />
          </div>
        )}
        {isExpanded && node.children.map(child => renderFolderRow(child))}
      </React.Fragment>
    );
  };

  const selectedFolderPath = selectedFolderId
    ? (folderLookups.pathById.get(selectedFolderId) ?? '')
    : '';
  const destinationFolderLabel = selectedFolderPath || 'Team root';
  const destinationFullPath = selectedFolderPath
    ? `${selectedFolderPath.split('/').join(' / ')} /`
    : 'Team root /';

  const isRootCreateOpen = newFolderParentId === null;
  const canConfirm = Boolean(sharedBaseName.trim())
    && !isRefreshingFolders
    && !folderRefreshFailed
    && hasInitializedSelection;
  const previewSharedName = `${sharedBaseName.trim() || fileNameParts.baseName}${fileNameParts.suffix}`;

  return (
    <div
      className="share-to-team-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="share-to-team-dialog w-[460px] max-w-[92%] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Share to Team"
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-[var(--nim-border)]">
          <div className="w-7 h-7 rounded-md bg-[var(--nim-primary)]/15 text-[var(--nim-primary)] flex items-center justify-center shrink-0 mt-0.5">
            <MaterialSymbol icon="group" size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--nim-text)] m-0 leading-tight">
              Share to Team
            </h2>
            <p className="text-[12px] text-[var(--nim-text-faint)] m-0 mt-0.5 leading-snug">
              Pick where this document should live in your team space.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-tertiary)] w-6 h-6 rounded inline-flex items-center justify-center"
            aria-label="Close"
          >
            <MaterialSymbol icon="close" size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 pt-3 pb-2">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--nim-text-faint)] mb-1.5">
            Source file
          </div>
          <div className="flex items-center gap-2.5 px-3 py-2 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-subtle,var(--nim-border))] rounded-md mb-4">
            <MaterialSymbol icon={descriptor.icon} size={20} className="text-[var(--nim-primary)] shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-[var(--nim-text)] truncate">{fileName}</div>
              <div className="text-[11px] text-[var(--nim-text-faint)] truncate">
                {descriptor.displayName} · {sourceRelPath}
              </div>
            </div>
          </div>

          <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--nim-text-faint)] mb-1.5">
            Shared name
          </div>
          <div className="flex items-center gap-1.5 px-2 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-subtle,var(--nim-border))] rounded-md mb-4 focus-within:border-[var(--nim-primary)]">
            <MaterialSymbol icon="edit" size={14} className="text-[var(--nim-text-faint)]" />
            <input
              type="text"
              value={sharedBaseName}
              onChange={(e) => {
                const nextName = e.target.value;
                setSharedBaseName(
                  nextName.toLowerCase().endsWith(fileNameParts.suffix.toLowerCase())
                    ? nextName.slice(0, -fileNameParts.suffix.length)
                    : nextName,
                );
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canConfirm) {
                  e.preventDefault();
                  handleConfirm();
                }
              }}
              className="flex-1 bg-transparent border-none text-[var(--nim-text)] text-[13px] py-2 outline-none font-inherit"
              placeholder="Document name"
            />
            <span className="text-[12px] text-[var(--nim-text-muted)] pr-1 shrink-0">
              {fileNameParts.suffix}
            </span>
          </div>

          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--nim-text-faint)]">
              Destination folder
            </div>
            <button
              type="button"
              onClick={() => beginNewFolder(selectedFolderId)}
              disabled={isRefreshingFolders || folderRefreshFailed || !hasInitializedSelection}
              className="text-[11px] text-[var(--nim-primary)] hover:underline inline-flex items-center gap-1 disabled:opacity-50 disabled:no-underline"
            >
              <MaterialSymbol icon="create_new_folder" size={13} />
              New folder
            </button>
          </div>
          <div className="share-to-team-tree bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-subtle,var(--nim-border))] rounded-md p-1 mb-3 max-h-[240px] overflow-y-auto">
            {isRefreshingFolders ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-[12px] text-[var(--nim-text-muted)]">
                <MaterialSymbol icon="progress_activity" size={16} className="animate-spin" />
                Refreshing shared folders…
              </div>
            ) : folderRefreshFailed ? (
              <div className="px-3 py-6 text-center text-[12px] text-[var(--nim-text-muted)]">
                Shared folders could not be refreshed. Close this dialog and try again.
              </div>
            ) : (
              <>
            {/* Team root row */}
            <div
              role="treeitem"
              aria-selected={selectedFolderId === null}
              tabIndex={0}
              onClick={() => setSelectedFolderId(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedFolderId(null);
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
              <span className="flex-1 truncate">Team root</span>
              {resolvedLastSharedFolderId === null && (
                <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-[var(--nim-primary)]/15 text-[var(--nim-primary)]">
                  last used
                </span>
              )}
            </div>

            {folderTree.map(node => renderFolderRow(node))}

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
                  placeholder="Folder name"
                  className="flex-1 bg-[var(--nim-bg)] border border-[var(--nim-primary)] rounded text-[13px] text-[var(--nim-text)] px-2 py-1 outline-none"
                />
              </div>
            )}
              </>
            )}
          </div>

          <div className="flex items-center gap-2 px-3 py-2 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-subtle,var(--nim-border))] rounded-md mb-3 text-[12px] text-[var(--nim-text-muted)]">
            <MaterialSymbol icon="place" size={14} className="text-[var(--nim-text-faint)]" />
            <span>Will be shared as</span>
            <span className="text-[var(--nim-text)] font-medium truncate" title={destinationFolderLabel}>
              {destinationFullPath}
            </span>
            <span className="text-[var(--nim-primary)] truncate" title={previewSharedName}>
              {previewSharedName}
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--nim-border)]">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 bg-transparent rounded-md text-[var(--nim-text-muted)] text-[13px] hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            className={`px-3.5 py-1.5 rounded-md text-[13px] font-medium inline-flex items-center gap-1.5 ${
              canConfirm
                ? 'bg-[var(--nim-primary)] text-[#0f1115] hover:bg-[var(--nim-primary-hover)] hover:text-white cursor-pointer'
                : 'bg-[var(--nim-primary)] text-[#0f1115] opacity-50 cursor-not-allowed'
            }`}
          >
            <MaterialSymbol icon="group_add" size={16} />
            Share to Team
          </button>
        </div>
      </div>
    </div>
  );
}
