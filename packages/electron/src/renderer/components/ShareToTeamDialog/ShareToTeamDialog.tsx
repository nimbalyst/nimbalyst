import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { sharedDocumentsAtom } from '../../store/atoms/collabDocuments';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import {
  getCollabDocumentPath,
  getCollabParentPath,
  joinCollabPath,
  normalizeCollabPath,
} from '../CollabMode/collabTree';

export interface ShareToTeamDialogProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  /** Workspace-relative path used as the source label in the dialog. */
  sourceRelPath: string;
  /**
   * Called when the user confirms. Returns the selected destination folder
   * (empty string = team root) and the shared name (with extension).
   */
  onConfirm: (params: { folderPath: string; sharedName: string }) => void;
}

interface FolderNode {
  path: string;
  name: string;
  depth: number;
  children: FolderNode[];
}

// Build a folder-only tree from existing shared-document titles + custom folders.
// Document titles look like "Engineering/Design Reviews/foo.md"; we strip the
// filename segment (the leaf) and keep every intermediate path as a folder.
function buildFolderTree(documentTitles: string[], customFolders: string[]): FolderNode[] {
  const folderPaths = new Set<string>();

  for (const title of documentTitles) {
    let cursor = getCollabParentPath(normalizeCollabPath(title));
    while (cursor) {
      folderPaths.add(cursor);
      cursor = getCollabParentPath(cursor);
    }
  }
  for (const folder of customFolders) {
    const normalized = normalizeCollabPath(folder);
    if (normalized) folderPaths.add(normalized);
  }

  const sorted = Array.from(folderPaths).sort();
  const byPath = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];

  for (const path of sorted) {
    const parts = path.split('/');
    const node: FolderNode = {
      path,
      name: parts[parts.length - 1],
      depth: parts.length - 1,
      children: [],
    };
    byPath.set(path, node);
    const parentPath = getCollabParentPath(path);
    if (parentPath && byPath.has(parentPath)) {
      byPath.get(parentPath)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

export function ShareToTeamDialog({
  isOpen,
  onClose,
  fileName,
  sourceRelPath,
  onConfirm,
}: ShareToTeamDialogProps) {
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  const workspacePath = useAtomValue(activeWorkspacePathAtom);

  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [pendingCustomFolders, setPendingCustomFolders] = useState<string[]>([]);
  const [lastSharedFolder, setLastSharedFolder] = useState<string>('');
  const [hasLastSharedFolder, setHasLastSharedFolder] = useState(false);
  const [hasLoadedState, setHasLoadedState] = useState(false);

  const [selectedFolder, setSelectedFolder] = useState<string>('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [sharedName, setSharedName] = useState<string>(fileName);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState<string>('');

  // Reset transient state every time the dialog opens for a different file.
  useEffect(() => {
    if (!isOpen) return;
    setSharedName(fileName);
    setNewFolderParent(null);
    setNewFolderName('');
  }, [isOpen, fileName]);

  // Load workspace-persisted state: custom folders + last-shared folder.
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
        const persistedCustom = Array.isArray(state?.collabTree?.customFolders)
          ? state.collabTree.customFolders.map((f: string) => normalizeCollabPath(f)).filter(Boolean)
          : [];
        const hasPersistedLast = typeof state?.collabTree?.lastSharedFolder === 'string';
        const persistedLast = hasPersistedLast
          ? normalizeCollabPath(state.collabTree.lastSharedFolder)
          : '';
        setCustomFolders(Array.from(new Set(persistedCustom)));
        setLastSharedFolder(persistedLast);
        setHasLastSharedFolder(hasPersistedLast);
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

  const documentTitles = useMemo(
    () => sharedDocuments.map(doc => getCollabDocumentPath(doc)),
    [sharedDocuments],
  );

  const folderTree = useMemo(
    () => buildFolderTree(documentTitles, [...customFolders, ...pendingCustomFolders]),
    [documentTitles, customFolders, pendingCustomFolders],
  );

  const allFolderPaths = useMemo(() => {
    const set = new Set<string>();
    const walk = (nodes: FolderNode[]) => {
      for (const node of nodes) {
        set.add(node.path);
        walk(node.children);
      }
    };
    walk(folderTree);
    return set;
  }, [folderTree]);

  // After state loads, seed the selection + expanded state from last-used.
  useEffect(() => {
    if (!isOpen || !hasLoadedState) return;
    const candidate =
      hasLastSharedFolder && lastSharedFolder === ''
        ? ''
        : lastSharedFolder && allFolderPaths.has(lastSharedFolder)
          ? lastSharedFolder
          : '';
    setSelectedFolder(candidate);
    const expanded = new Set<string>();
    let cursor: string | null = candidate;
    while (cursor) {
      expanded.add(cursor);
      cursor = getCollabParentPath(cursor);
    }
    setExpandedFolders(expanded);
  }, [isOpen, hasLoadedState, hasLastSharedFolder, lastSharedFolder, allFolderPaths]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // The "New folder" button (above the tree) creates a child of whatever's
  // currently selected. `null` parent here is "root"; empty string '' is the
  // canonical normalized form we use elsewhere — they mean the same thing.
  const beginNewFolder = useCallback((parent: string | null) => {
    const normalizedParent = parent ?? '';
    setNewFolderParent(normalizedParent);
    setNewFolderName('');
    if (normalizedParent) {
      setExpandedFolders(prev => {
        const next = new Set(prev);
        next.add(normalizedParent);
        return next;
      });
    }
  }, []);

  const commitNewFolder = useCallback(() => {
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setNewFolderParent(null);
      setNewFolderName('');
      return;
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      // Reject path separators; folder names are single segments.
      return;
    }
    const parent = newFolderParent ?? '';
    const fullPath = parent
      ? joinCollabPath(parent, trimmed)
      : normalizeCollabPath(trimmed);
    if (!fullPath || allFolderPaths.has(fullPath)) {
      setNewFolderParent(null);
      setNewFolderName('');
      setSelectedFolder(fullPath);
      return;
    }
    setPendingCustomFolders(prev => Array.from(new Set([...prev, fullPath])));
    setSelectedFolder(fullPath);
    setExpandedFolders(prev => {
      const next = new Set(prev);
      next.add(fullPath);
      if (parent) next.add(parent);
      return next;
    });
    setNewFolderParent(null);
    setNewFolderName('');
  }, [allFolderPaths, newFolderName, newFolderParent]);

  const cancelNewFolder = useCallback(() => {
    setNewFolderParent(null);
    setNewFolderName('');
  }, []);

  const handleConfirm = useCallback(() => {
    const trimmedName = sharedName.trim();
    if (!trimmedName) return;
    onConfirm({ folderPath: selectedFolder, sharedName: trimmedName });
    onClose();
  }, [onClose, onConfirm, selectedFolder, sharedName]);

  if (!isOpen) return null;

  const renderFolderRow = (node: FolderNode) => {
    const isExpanded = expandedFolders.has(node.path);
    const isSelected = selectedFolder === node.path;
    const isLastUsed = hasLastSharedFolder && lastSharedFolder !== '' && node.path === lastSharedFolder;
    const hasChildren = node.children.length > 0;
    const showInlineNewFolder = newFolderParent === node.path;
    const depthPx = 8 + node.depth * 18;

    return (
      <React.Fragment key={node.path}>
        <div
          role="treeitem"
          aria-selected={isSelected}
          tabIndex={0}
          onClick={() => setSelectedFolder(node.path)}
          onDoubleClick={() => toggleFolder(node.path)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setSelectedFolder(node.path);
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
              if (hasChildren) toggleFolder(node.path);
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
                  commitNewFolder();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelNewFolder();
                }
              }}
              onBlur={commitNewFolder}
              placeholder="Folder name"
              className="flex-1 bg-[var(--nim-bg)] border border-[var(--nim-primary)] rounded text-[13px] text-[var(--nim-text)] px-2 py-1 outline-none"
            />
          </div>
        )}
        {isExpanded && node.children.map(child => renderFolderRow(child))}
      </React.Fragment>
    );
  };

  const destinationFolderLabel = selectedFolder || 'Team root';
  const destinationFullPath = selectedFolder
    ? `${selectedFolder.split('/').join(' / ')} /`
    : 'Team root /';

  const isRootCreateOpen = newFolderParent === '';

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
            <MaterialSymbol icon="description" size={20} className="text-[var(--nim-primary)] shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-[var(--nim-text)] truncate">{fileName}</div>
              <div className="text-[11px] text-[var(--nim-text-faint)] truncate">{sourceRelPath}</div>
            </div>
          </div>

          <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--nim-text-faint)] mb-1.5">
            Shared name
          </div>
          <div className="flex items-center gap-1.5 px-2 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-subtle,var(--nim-border))] rounded-md mb-4 focus-within:border-[var(--nim-primary)]">
            <MaterialSymbol icon="edit" size={14} className="text-[var(--nim-text-faint)]" />
            <input
              type="text"
              value={sharedName}
              onChange={(e) => setSharedName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && sharedName.trim()) {
                  e.preventDefault();
                  handleConfirm();
                }
              }}
              className="flex-1 bg-transparent border-none text-[var(--nim-text)] text-[13px] py-2 outline-none font-inherit"
              placeholder="document.md"
            />
          </div>

          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--nim-text-faint)]">
              Destination folder
            </div>
            <button
              type="button"
              onClick={() => beginNewFolder(selectedFolder || null)}
              className="text-[11px] text-[var(--nim-primary)] hover:underline inline-flex items-center gap-1"
            >
              <MaterialSymbol icon="create_new_folder" size={13} />
              New folder
            </button>
          </div>
          <div className="share-to-team-tree bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-subtle,var(--nim-border))] rounded-md p-1 mb-3 max-h-[240px] overflow-y-auto">
            {/* Team root row */}
            <div
              role="treeitem"
              aria-selected={selectedFolder === ''}
              tabIndex={0}
              onClick={() => setSelectedFolder('')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelectedFolder('');
                }
              }}
              className={`relative flex items-center gap-1 px-2 py-1.5 rounded text-[13px] cursor-pointer select-none ${
                selectedFolder === ''
                  ? 'bg-[var(--nim-primary)]/20 text-[var(--nim-text)]'
                  : 'text-[var(--nim-text)] hover:bg-[var(--nim-bg-tertiary)]'
              }`}
              style={{ paddingLeft: 8 }}
            >
              {selectedFolder === '' && (
                <span aria-hidden className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-[var(--nim-primary)]" />
              )}
              <span className="w-4 h-4 inline-flex items-center justify-center text-[var(--nim-text-faint)] invisible">
                <MaterialSymbol icon="chevron_right" size={16} />
              </span>
              <span className={`inline-flex items-center justify-center ${selectedFolder === '' ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-muted)]'}`}>
                <MaterialSymbol icon="workspaces" size={18} />
              </span>
              <span className="flex-1 truncate">Team root</span>
              {hasLastSharedFolder && lastSharedFolder === '' && (
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
                      commitNewFolder();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelNewFolder();
                    }
                  }}
                  onBlur={commitNewFolder}
                  placeholder="Folder name"
                  className="flex-1 bg-[var(--nim-bg)] border border-[var(--nim-primary)] rounded text-[13px] text-[var(--nim-text)] px-2 py-1 outline-none"
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 px-3 py-2 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-subtle,var(--nim-border))] rounded-md mb-3 text-[12px] text-[var(--nim-text-muted)]">
            <MaterialSymbol icon="place" size={14} className="text-[var(--nim-text-faint)]" />
            <span>Will be shared as</span>
            <span className="text-[var(--nim-text)] font-medium truncate" title={destinationFolderLabel}>
              {destinationFullPath}
            </span>
            <span className="text-[var(--nim-primary)] truncate" title={sharedName}>
              {sharedName || fileName}
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
            disabled={!sharedName.trim()}
            className={`px-3.5 py-1.5 rounded-md text-[13px] font-medium inline-flex items-center gap-1.5 ${
              sharedName.trim()
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
