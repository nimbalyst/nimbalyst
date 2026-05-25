import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { InputModal } from '../InputModal';
import { WorkspaceSummaryHeader } from '../WorkspaceSummaryHeader';
import { useFloatingMenu, FloatingPortal, virtualElement } from '../../hooks/useFloatingMenu';
import {
  sharedDocumentsAtom,
  teamSyncStatusAtom,
  removeSharedDocument,
  updateSharedDocumentTitle,
  activeTeamOrgIdAtom,
  buildSharedDocumentDeepLink,
  type SharedDocument,
} from '../../store/atoms/collabDocuments';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import {
  buildCollabTree,
  getCollabDocumentPath,
  getCollabNodeName,
  getCollabParentPath,
  joinCollabPath,
  normalizeCollabPath,
  renameCollabDocumentPath,
  type CollabTreeNode,
} from './collabTree';
import { registerDocumentInIndex } from '../../store/atoms/collabDocuments';
import { useCollabLocalOrigin } from '../../hooks/useCollabLocalOrigin';

// ---------------------------------------------------------------------------
// TeamSync status indicator -- shown in the header subtitle slot
// ---------------------------------------------------------------------------

type TeamSyncStatus = 'disconnected' | 'connecting' | 'syncing' | 'connected' | 'error';

const STATUS_CONFIG: Record<TeamSyncStatus, { label: string; dotClass: string }> = {
  connected:    { label: 'Team synced',   dotClass: 'bg-green-500' },
  syncing:      { label: 'Syncing...',    dotClass: 'bg-blue-500 animate-pulse' },
  connecting:   { label: 'Connecting...', dotClass: 'bg-yellow-500 animate-pulse' },
  disconnected: { label: 'Disconnected',  dotClass: 'bg-gray-500' },
  error:        { label: 'Sync error',    dotClass: 'bg-red-500' },
};

const TeamSyncStatusLabel: React.FC<{ status: TeamSyncStatus }> = ({ status }) => {
  const { label, dotClass } = STATUS_CONFIG[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      <span>{label}</span>
    </span>
  );
};

interface CollabSidebarProps {
  workspacePath: string;
  onDocumentSelect: (doc: SharedDocument) => void;
  activeDocumentId?: string | null;
}

export const CollabSidebar: React.FC<CollabSidebarProps> = ({
  workspacePath,
  onDocumentSelect,
  activeDocumentId,
}) => {
  const sharedDocuments = useAtomValue(sharedDocumentsAtom);
  const teamSyncStatus = useAtomValue(teamSyncStatusAtom);
  const teamOrgId = useAtomValue(activeTeamOrgIdAtom);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: CollabTreeNode;
  } | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [customFolders, setCustomFolders] = useState<string[]>([]);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [isCreateDocumentOpen, setIsCreateDocumentOpen] = useState(false);
  const [isCreateFolderOpen, setIsCreateFolderOpen] = useState(false);
  const [documentToRename, setDocumentToRename] = useState<SharedDocument | null>(null);
  const [hasLoadedState, setHasLoadedState] = useState(false);
  const [loadedWorkspacePath, setLoadedWorkspacePath] = useState<string | null>(null);
  const [draggedDocument, setDraggedDocument] = useState<{
    documentId: string;
    sourcePath: string;
    name: string;
  } | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);

  const tree = useMemo(
    () => buildCollabTree(sharedDocuments, customFolders),
    [sharedDocuments, customFolders]
  );

  const existingPaths = useMemo(() => {
    const paths = new Set<string>();

    const collect = (nodes: CollabTreeNode[]) => {
      for (const node of nodes) {
        paths.add(node.path);
        if (node.type === 'folder') {
          collect(node.children);
        }
      }
    };

    collect(tree);
    return paths;
  }, [tree]);

  const activeDocument = useMemo(
    () => sharedDocuments.find(document => document.documentId === activeDocumentId) ?? null,
    [activeDocumentId, sharedDocuments]
  );

  const canMutateMetadata = useCallback((actionLabel: string) => {
    if (teamSyncStatus === 'connected') {
      return true;
    }

    window.alert(
      `Cannot ${actionLabel} while shared document sync is ${teamSyncStatus}. Reconnect to the team before changing shared document metadata.`
    );
    return false;
  }, [teamSyncStatus]);

  const contextMenuReference = useMemo(
    () => (contextMenu ? virtualElement(contextMenu.x, contextMenu.y) : null),
    [contextMenu]
  );
  const contextMenuFloating = useFloatingMenu({
    placement: 'right-start',
    reference: contextMenuReference,
    open: contextMenu !== null,
    onOpenChange: (open) => {
      if (!open) setContextMenu(null);
    },
  });

  useEffect(() => {
    setHasLoadedState(false);
    setLoadedWorkspacePath(null);
    setContextMenu(null);
    setDocumentToRename(null);
    setSelectedFolderPath(null);
    setExpandedFolders(new Set());
    setCustomFolders([]);

    if (!workspacePath || !window.electronAPI?.invoke) {
      setHasLoadedState(true);
      return;
    }

    let cancelled = false;
    window.electronAPI.invoke('workspace:get-state', workspacePath)
      .then((state) => {
        if (cancelled) return;

        const nextExpanded = Array.isArray(state?.collabTree?.expandedFolders)
          ? state.collabTree.expandedFolders.map((folder: string) => normalizeCollabPath(folder)).filter(Boolean)
          : [];
        const nextFolders = Array.isArray(state?.collabTree?.customFolders)
          ? state.collabTree.customFolders.map((folder: string) => normalizeCollabPath(folder)).filter(Boolean)
          : [];

        setExpandedFolders(new Set(nextExpanded));
        setCustomFolders(Array.from(new Set(nextFolders)));
        setHasLoadedState(true);
        setLoadedWorkspacePath(workspacePath);
      })
      .catch(() => {
        if (cancelled) return;
        setHasLoadedState(true);
        setLoadedWorkspacePath(workspacePath);
      });

    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  useEffect(() => {
    if (!hasLoadedState || loadedWorkspacePath !== workspacePath || !workspacePath || !window.electronAPI?.invoke) return;

    const payload = {
      collabTree: {
        expandedFolders: Array.from(expandedFolders),
        customFolders,
      },
    };

    window.electronAPI.invoke('workspace:update-state', workspacePath, payload).catch((error) => {
      console.warn('[CollabSidebar] Failed to persist tree state:', error);
    });
  }, [customFolders, expandedFolders, hasLoadedState, loadedWorkspacePath, workspacePath]);

  useEffect(() => {
    if (!activeDocument) return;
    const path = getCollabDocumentPath(activeDocument);
    const parents: string[] = [];
    let current = getCollabParentPath(path);
    while (current) {
      parents.unshift(current);
      current = getCollabParentPath(current);
    }

    if (parents.length === 0) return;

    setExpandedFolders((currentFolders) => {
      const next = new Set(currentFolders);
      let changed = false;
      for (const folderPath of parents) {
        if (!next.has(folderPath)) {
          next.add(folderPath);
          changed = true;
        }
      }
      return changed ? next : currentFolders;
    });
  }, [activeDocument]);

  const handleContextMenu = useCallback((e: React.MouseEvent, node: CollabTreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    if (node.type === 'folder') {
      setSelectedFolderPath(node.path);
    }
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  }, []);

  const handleCopyLink = useCallback(async (document: SharedDocument) => {
    if (!teamOrgId) {
      errorNotificationService.showWarning(
        'No team configured',
        'This workspace is not connected to a team, so no shareable link is available.',
        { duration: 4000 }
      );
      return;
    }
    const url = buildSharedDocumentDeepLink(document.documentId, teamOrgId);
    try {
      await navigator.clipboard.writeText(url);
      errorNotificationService.showInfo(
        'Link copied',
        'Paste it anywhere to open this document in Nimbalyst.',
        { duration: 3000 }
      );
    } catch (err) {
      console.error('[CollabSidebar] Failed to copy link:', err);
      errorNotificationService.showError(
        'Copy failed',
        'Could not write the link to the clipboard.'
      );
    }
  }, [teamOrgId]);

  const handleDelete = useCallback(() => {
    if (!contextMenu || contextMenu.node.type !== 'document') return;
    if (!canMutateMetadata('delete this document')) return;
    const { document } = contextMenu.node;
    if (window.confirm(`Delete shared document "${document.title}"?`)) {
      removeSharedDocument(document.documentId);
    }
    setContextMenu(null);
  }, [canMutateMetadata, contextMenu]);

  const toggleFolder = useCallback((folderPath: string) => {
    setExpandedFolders((currentFolders) => {
      const next = new Set(currentFolders);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  }, []);

  const getCreationBaseFolder = useCallback(() => {
    return contextMenu?.node.type === 'folder'
      ? contextMenu.node.path
      : selectedFolderPath;
  }, [contextMenu, selectedFolderPath]);

  const handleCreateFolder = useCallback((folderName: string) => {
    const nextPath = joinCollabPath(getCreationBaseFolder(), folderName);
    if (!nextPath) return;

    if (existingPaths.has(nextPath)) {
      window.alert(`A document or folder named "${nextPath}" already exists.`);
      return;
    }

    setCustomFolders((currentFolders) => Array.from(new Set([...currentFolders, nextPath])));
    setExpandedFolders((currentFolders) => {
      const next = new Set(currentFolders);
      next.add(nextPath);
      const parent = getCollabParentPath(nextPath);
      if (parent) {
        next.add(parent);
      }
      return next;
    });
    setSelectedFolderPath(nextPath);
    setIsCreateFolderOpen(false);
    setContextMenu(null);
  }, [existingPaths, getCreationBaseFolder]);

  const handleCreateDocument = useCallback(async (documentName: string) => {
    if (!canMutateMetadata('create documents')) return;

    const title = joinCollabPath(getCreationBaseFolder(), documentName);
    if (!title) return;

    if (existingPaths.has(title)) {
      window.alert(`A document or folder named "${title}" already exists.`);
      return;
    }

    const now = Date.now();
    const documentId = crypto.randomUUID();
    const document: SharedDocument = {
      documentId,
      title,
      documentType: 'markdown',
      createdBy: '',
      createdAt: now,
      updatedAt: now,
    };

    await registerDocumentInIndex(documentId, title, 'markdown');

    const parent = getCollabParentPath(title);
    if (parent) {
      setExpandedFolders((currentFolders) => {
        const next = new Set(currentFolders);
        next.add(parent);
        return next;
      });
    }

    setSelectedFolderPath(parent);
    setIsCreateDocumentOpen(false);
    setContextMenu(null);
    onDocumentSelect(document);
  }, [canMutateMetadata, existingPaths, getCreationBaseFolder, onDocumentSelect]);

  const handleRenameDocument = useCallback(async (documentName: string) => {
    if (!documentToRename) return;
    if (!canMutateMetadata('rename this document')) return;

    const currentPath = getCollabDocumentPath(documentToRename);
    const nextPath = renameCollabDocumentPath(currentPath, documentName);
    if (!nextPath || nextPath === currentPath) {
      setDocumentToRename(null);
      setContextMenu(null);
      return;
    }

    if (existingPaths.has(nextPath)) {
      window.alert(`A document or folder named "${nextPath}" already exists.`);
      return;
    }

    await updateSharedDocumentTitle(documentToRename.documentId, nextPath);

    const parent = getCollabParentPath(nextPath);
    if (parent) {
      setExpandedFolders((currentFolders) => {
        const next = new Set(currentFolders);
        next.add(parent);
        return next;
      });
    }

    setSelectedFolderPath(parent);
    setDocumentToRename(null);
    setContextMenu(null);
  }, [canMutateMetadata, documentToRename, existingPaths]);

  const moveDraggedDocument = useCallback(async (targetFolderPath: string | null) => {
    if (!draggedDocument) return;
    if (!canMutateMetadata('move this document')) {
      setDropTargetPath(null);
      setDraggedDocument(null);
      return;
    }

    const nextPath = joinCollabPath(targetFolderPath, draggedDocument.name);
    if (!nextPath || nextPath === draggedDocument.sourcePath) {
      setDropTargetPath(null);
      setDraggedDocument(null);
      return;
    }

    if (existingPaths.has(nextPath) && nextPath !== draggedDocument.sourcePath) {
      window.alert(`A document or folder named "${nextPath}" already exists.`);
      setDropTargetPath(null);
      setDraggedDocument(null);
      return;
    }

    await updateSharedDocumentTitle(draggedDocument.documentId, nextPath);

    if (targetFolderPath) {
      setExpandedFolders((currentFolders) => {
        const next = new Set(currentFolders);
        next.add(targetFolderPath);
        return next;
      });
      setSelectedFolderPath(targetFolderPath);
    } else {
      setSelectedFolderPath(null);
    }

    setDropTargetPath(null);
    setDraggedDocument(null);
  }, [canMutateMetadata, draggedDocument, existingPaths]);

  const canDropDocument = useCallback((targetFolderPath: string | null) => {
    if (!draggedDocument) return false;

    const nextPath = joinCollabPath(targetFolderPath, draggedDocument.name);
    if (!nextPath || nextPath === draggedDocument.sourcePath) {
      return false;
    }

    return !existingPaths.has(nextPath) || nextPath === draggedDocument.sourcePath;
  }, [draggedDocument, existingPaths]);

  const renderTree = useCallback((nodes: CollabTreeNode[], depth = 0): React.ReactNode => {
    return nodes.map((node) => {
      const indent = depth * 16 + 8;

      if (node.type === 'folder') {
        const isExpanded = expandedFolders.has(node.path);
        const isSelected = selectedFolderPath === node.path;
        const isDropTarget = dropTargetPath === node.path;

        return (
          <div key={node.id}>
            <button
              className={`w-full flex items-center text-left file-tree-directory${isSelected ? ' selected' : ''}${isDropTarget ? ' drag-over' : ''}`}
              style={{ paddingLeft: indent }}
              onClick={() => {
                toggleFolder(node.path);
                setSelectedFolderPath(node.path);
              }}
              onContextMenu={(event) => handleContextMenu(event, node)}
              onDragOver={(event) => {
                if (!canDropDocument(node.path)) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = 'move';
                if (dropTargetPath !== node.path) {
                  setDropTargetPath(node.path);
                }
              }}
              onDragLeave={(event) => {
                event.stopPropagation();
                const relatedTarget = event.relatedTarget as Node | null;
                if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
                  return;
                }
                if (dropTargetPath === node.path) {
                  setDropTargetPath(null);
                }
              }}
              onDrop={(event) => {
                if (!canDropDocument(node.path)) return;
                event.preventDefault();
                event.stopPropagation();
                void moveDraggedDocument(node.path);
              }}
              title={node.path}
            >
              <span className="file-tree-chevron">
                <MaterialSymbol
                  icon={isExpanded ? 'keyboard_arrow_down' : 'keyboard_arrow_right'}
                  size={16}
                />
              </span>
              <span className="file-tree-icon">
                <MaterialSymbol icon={isExpanded ? 'folder_open' : 'folder'} size={18} />
              </span>
              <span className="file-tree-name">{node.name}</span>
            </button>
            {isExpanded ? renderTree(node.children, depth + 1) : null}
          </div>
        );
      }

      const isActive = node.document.documentId === activeDocumentId;

      return (
        <button
          key={node.id}
          className={`w-full flex items-center text-left file-tree-file${isActive ? ' active' : ''}`}
          style={{ paddingLeft: indent }}
          onClick={() => {
            setSelectedFolderPath(getCollabParentPath(node.path));
            onDocumentSelect(node.document);
          }}
          onContextMenu={(event) => handleContextMenu(event, node)}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', node.document.documentId);
            setDraggedDocument({
              documentId: node.document.documentId,
              sourcePath: node.path,
              name: node.name,
            });
          }}
          onDragEnd={() => {
            setDraggedDocument(null);
            setDropTargetPath(null);
          }}
          title={node.path}
        >
          <span className="file-tree-spacer" />
          <span className="file-tree-icon">
            <MaterialSymbol icon="description" size={16} />
          </span>
          <span className="file-tree-name">{node.name}</span>
        </button>
      );
    });
  }, [
    activeDocumentId,
    canDropDocument,
    dropTargetPath,
    expandedFolders,
    handleContextMenu,
    moveDraggedDocument,
    onDocumentSelect,
    selectedFolderPath,
    toggleFolder,
  ]);

  const selectedFolderLabel = selectedFolderPath ? getCollabNodeName(selectedFolderPath) : 'Shared Docs';
  const contextDocument = contextMenu?.node.type === 'document' ? contextMenu.node.document : null;
  const contextLocalOrigin = useCollabLocalOrigin(
    workspacePath,
    contextDocument?.documentId,
    contextDocument?.documentType,
  );

  return (
    <div
      className="collab-sidebar w-full h-full flex flex-col bg-nim-secondary border-r border-nim overflow-hidden"
      data-testid="collab-sidebar"
    >
      {/* Header -- matches WorkspaceSummaryHeader used by EditorMode */}
      <WorkspaceSummaryHeader
        workspacePath={workspacePath}
        subtitle={<TeamSyncStatusLabel status={teamSyncStatus} />}
        actionsClassName="gap-1"
        actions={
          <>
            <button
              type="button"
              className="workspace-action-button bg-transparent border-none p-1.5 cursor-pointer rounded text-[var(--nim-text-faint)] flex items-center justify-center transition-all duration-200 relative hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              title="New document"
              onClick={() => {
                setIsCreateDocumentOpen(true);
                setContextMenu(null);
              }}
            >
              <MaterialSymbol icon="note_add" size={16} />
            </button>
            <button
              type="button"
              className="workspace-action-button bg-transparent border-none p-1.5 cursor-pointer rounded text-[var(--nim-text-faint)] flex items-center justify-center transition-all duration-200 relative hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              title="New folder"
              onClick={() => {
                setIsCreateFolderOpen(true);
                setContextMenu(null);
              }}
            >
              <MaterialSymbol icon="create_new_folder" size={16} />
            </button>
          </>
        }
      />

      {/* Document tree */}
      <div
        className={`flex-1 overflow-y-auto px-1.5 py-2 transition-colors ${dropTargetPath === '__root__' ? 'bg-nim-hover' : ''}`}
        onDragOver={(event) => {
          if (!canDropDocument(null)) return;
          const target = event.target as HTMLElement;
          if (target.closest('.file-tree-directory, .file-tree-file')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          if (dropTargetPath !== '__root__') {
            setDropTargetPath('__root__');
          }
        }}
        onDragLeave={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('.file-tree-directory, .file-tree-file')) return;
          const relatedTarget = event.relatedTarget as Node | null;
          if (relatedTarget && event.currentTarget.contains(relatedTarget)) {
            return;
          }
          if (dropTargetPath === '__root__') {
            setDropTargetPath(null);
          }
        }}
        onDrop={(event) => {
          if (!canDropDocument(null)) return;
          const target = event.target as HTMLElement;
          if (target.closest('.file-tree-directory, .file-tree-file')) return;
          event.preventDefault();
          void moveDraggedDocument(null);
        }}
      >
        {tree.length === 0 ? (
          <div className="px-2 py-4 text-center">
            <MaterialSymbol icon="cloud_sync" size={32} className="text-nim-faint mb-2" />
            <p className="text-xs text-nim-faint m-0">
              No shared documents yet.
            </p>
            <p className="text-xs text-nim-faint mt-1 m-0">
              Create one here or share a local file to collaborate.
            </p>
          </div>
        ) : (
          <div>{renderTree(tree)}</div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <FloatingPortal>
          <div
            ref={contextMenuFloating.refs.setFloating}
            style={contextMenuFloating.floatingStyles}
            {...contextMenuFloating.getFloatingProps()}
            className="min-w-[160px] rounded-md z-[10000] text-[13px] p-1 bg-nim-secondary border border-nim text-nim backdrop-blur-[10px] shadow-lg"
          >
          {contextMenu.node.type === 'folder' ? (
            <>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover"
                onClick={() => setIsCreateDocumentOpen(true)}
              >
                <MaterialSymbol icon="note_add" size={18} />
                <span>New Document</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover"
                onClick={() => setIsCreateFolderOpen(true)}
              >
                <MaterialSymbol icon="create_new_folder" size={18} />
                <span>New Folder</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover"
                onClick={() => {
                  if (!contextDocument) return;
                  onDocumentSelect(contextDocument);
                  setContextMenu(null);
                }}
              >
                <MaterialSymbol icon="open_in_new" size={18} />
                <span>Open</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!teamOrgId}
                title={teamOrgId ? undefined : 'No team is connected to this workspace'}
                onClick={() => {
                  if (!contextDocument) return;
                  setContextMenu(null);
                  void handleCopyLink(contextDocument);
                }}
              >
                <MaterialSymbol icon="link" size={18} />
                <span>Copy Link</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover"
                onClick={() => {
                  if (!contextDocument) return;
                  setDocumentToRename(contextDocument);
                  setContextMenu(null);
                }}
              >
                <MaterialSymbol icon="edit" size={18} />
                <span>Rename</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!contextLocalOrigin.hasResolvedBinding || contextLocalOrigin.busyAction !== null}
                onClick={() => {
                  setContextMenu(null);
                  void contextLocalOrigin.openLocalSource();
                }}
              >
                <MaterialSymbol icon="draft" size={18} />
                <span>Open Local Source</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!contextLocalOrigin.binding || contextLocalOrigin.busyAction !== null}
                onClick={() => {
                  setContextMenu(null);
                  void contextLocalOrigin.reuploadFromLocalSource();
                }}
              >
                <MaterialSymbol icon="upload" size={18} />
                <span>Re-upload From Local</span>
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={contextLocalOrigin.busyAction !== null}
                onClick={() => {
                  setContextMenu(null);
                  void contextLocalOrigin.relinkLocalSource();
                }}
              >
                <MaterialSymbol icon="link" size={18} />
                <span>{contextLocalOrigin.binding ? 'Relink Local Source...' : 'Link Local Source...'}</span>
              </button>
              {contextLocalOrigin.binding && (
                <button
                  type="button"
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={contextLocalOrigin.busyAction !== null}
                  onClick={() => {
                    setContextMenu(null);
                    void contextLocalOrigin.clearLocalSource();
                  }}
                >
                  <MaterialSymbol icon="link_off" size={18} />
                  <span>Clear Local Source</span>
                </button>
              )}
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim-error hover:bg-nim-hover"
                onClick={handleDelete}
              >
                <MaterialSymbol icon="delete" size={18} />
                <span>Delete</span>
              </button>
            </>
          )}
          </div>
        </FloatingPortal>
      )}

      <InputModal
        isOpen={isCreateDocumentOpen}
        title="New Shared Document"
        placeholder="Document name"
        defaultValue=""
        confirmLabel="Create"
        onConfirm={handleCreateDocument}
        onCancel={() => {
          setIsCreateDocumentOpen(false);
          setContextMenu(null);
        }}
      />

      <InputModal
        isOpen={isCreateFolderOpen}
        title="New Shared Folder"
        placeholder="Folder name"
        defaultValue=""
        confirmLabel="Create"
        onConfirm={handleCreateFolder}
        onCancel={() => {
          setIsCreateFolderOpen(false);
          setContextMenu(null);
        }}
      />

      <InputModal
        isOpen={documentToRename !== null}
        title="Rename Shared Document"
        placeholder="Document name"
        defaultValue={documentToRename ? getCollabNodeName(getCollabDocumentPath(documentToRename)) : ''}
        confirmLabel="Rename"
        onConfirm={handleRenameDocument}
        onCancel={() => {
          setDocumentToRename(null);
          setContextMenu(null);
        }}
      />
    </div>
  );
};
