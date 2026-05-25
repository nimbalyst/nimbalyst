import React, { useState, useEffect, useRef } from 'react';

// Apply the active theme as a base dark/light class on the WorkspaceManager
// (project picker) window. The picker does not load the extension theme
// registry, so we rely on the main process's getResolvedThemeSync() to return
// 'dark' | 'crystal-dark' | 'light' regardless of whether the active theme is
// built-in, system, or extension-contributed.
const applyTheme = () => {
  if (typeof window === 'undefined') return;

  const resolved = window.electronAPI?.getResolvedThemeSync?.() ?? 'light';
  const root = document.documentElement;

  root.classList.remove('light-theme', 'dark-theme', 'crystal-dark-theme');

  if (resolved === 'dark') {
    root.setAttribute('data-theme', 'dark');
    root.classList.add('dark-theme');
  } else if (resolved === 'crystal-dark') {
    root.setAttribute('data-theme', 'crystal-dark');
    root.classList.add('crystal-dark-theme');
  } else {
    root.setAttribute('data-theme', 'light');
    root.classList.add('light-theme');
  }
};

// Apply theme on mount
applyTheme();

// Listen for theme changes from the main process. Re-running applyTheme()
// re-queries getThemeSync(), which already reflects the new active theme.
if (typeof window !== 'undefined' && window.electronAPI?.onThemeChange) {
  window.electronAPI.onThemeChange(() => {
    applyTheme();
  });
}

interface WorkspaceInfo {
  path: string;
  name: string;
  lastOpened: number | string;
  lastModified?: number | string;
  fileCount?: number;
  markdownCount?: number;
  exists: boolean;
}

interface WorkspaceStats {
  fileCount: number;
  markdownCount: number;
  totalSize: number;
  recentFiles: string[];
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  workspace: WorkspaceInfo | null;
}

export const WorkspaceManager: React.FC = () => {
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceInfo | null>(null);
  const [workspaceStats, setWorkspaceStats] = useState<WorkspaceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    workspace: null,
  });

  // Rename dialog state
  const [renameDialog, setRenameDialog] = useState<{
    visible: boolean;
    workspace: WorkspaceInfo | null;
    newName: string;
    error: string | null;
    stats?: WorkspaceStats | null;
  }>({
    visible: false,
    workspace: null,
    newName: '',
    error: null,
  });

  // Confirmation dialog state (for move operations)
  const [confirmDialog, setConfirmDialog] = useState<{
    visible: boolean;
    type: 'move' | 'rename';
    workspace: WorkspaceInfo | null;
    destinationPath?: string;
    newName?: string;
    stats?: WorkspaceStats | null;
  }>({
    visible: false,
    type: 'move',
    workspace: null,
  });

  // Operation state
  const [operationInProgress, setOperationInProgress] = useState(false);
  const [operationLabel, setOperationLabel] = useState('Moving project...');
  const [operationError, setOperationError] = useState<string | null>(null);

  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadWorkspaces();
  }, []);

  useEffect(() => {
    if (selectedWorkspace) {
      loadWorkspaceStats(selectedWorkspace.path);
    }
  }, [selectedWorkspace]);

  // Auto-select first item when search query changes or results update
  useEffect(() => {
    if (filteredWorkspaces.length > 0) {
      setHighlightedIndex(0);
      setSelectedWorkspace(filteredWorkspaces[0]);
    } else {
      setHighlightedIndex(-1);
      setSelectedWorkspace(null);
    }
  }, [searchQuery]);

  // Close context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu.visible) {
        setContextMenu(prev => ({ ...prev, visible: false }));
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [contextMenu.visible]);

  // Focus rename input when dialog opens
  useEffect(() => {
    if (renameDialog.visible && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameDialog.visible]);

  // Score and filter workspaces based on search query
  // Higher score = better match, prioritizing name matches over path matches
  const scoreWorkspace = (workspace: WorkspaceInfo, query: string): number => {
    const name = workspace.name.toLowerCase();
    const path = workspace.path.toLowerCase();
    const q = query.toLowerCase();

    // Exact name match (highest priority)
    if (name === q) return 100;

    // Name starts with query (prefix match)
    if (name.startsWith(q)) return 80;

    // Name contains query at word boundary (e.g., "My-JSVault" matches "js")
    const wordBoundaryRegex = new RegExp(`(?:^|[\\s_-])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
    if (wordBoundaryRegex.test(name)) return 60;

    // Name contains query anywhere
    if (name.includes(q)) return 40;

    // Path contains query
    if (path.includes(q)) return 20;

    // No match
    return 0;
  };

  const filteredWorkspaces = workspaces
    .map(workspace => ({
      workspace,
      score: searchQuery ? scoreWorkspace(workspace, searchQuery) : 1
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ workspace }) => workspace);

  const loadWorkspaces = async () => {
    try {
      const recentWorkspaces = await window.electronAPI.workspaceManager.getRecentWorkspaces();
      // console.log('Loaded workspaces:', recentWorkspaces);
      setWorkspaces(recentWorkspaces);
      // Don't auto-select first workspace - show welcome pane instead
    } catch (error) {
      console.error('Failed to load workspaces:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadWorkspaceStats = async (workspacePath: string) => {
    try {
      const stats = await window.electronAPI.workspaceManager.getWorkspaceStats(workspacePath);
      setWorkspaceStats(stats);
    } catch (error) {
      console.error('Failed to load workspace stats:', error);
    }
  };

  const handleOpenWorkspace = async () => {
    if (!selectedWorkspace) return;

    try {
      await window.electronAPI.workspaceManager.openWorkspace(selectedWorkspace.path);
    } catch (error) {
      console.error('Failed to open workspace:', error);
    }
  };

  const handleBrowse = async () => {
    try {
      const result = await window.electronAPI.workspaceManager.openFolderDialog();
      if (result.success) {
        await window.electronAPI.workspaceManager.openWorkspace(result.path);
      }
    } catch (error) {
      console.error('Failed to browse for workspace:', error);
    }
  };

  const handleCreateWorkspace = async () => {
    try {
      const result = await window.electronAPI.workspaceManager.createWorkspaceDialog();
      if (result.success) {
        await window.electronAPI.workspaceManager.openWorkspace(result.path);
      }
    } catch (error) {
      console.error('Failed to create workspace:', error);
    }
  };

  const handleRemoveFromRecent = async (workspace?: WorkspaceInfo) => {
    const target = workspace || selectedWorkspace;
    if (!target) return;

    try {
      await window.electronAPI.workspaceManager.removeRecent(target.path);
      await loadWorkspaces();
      if (selectedWorkspace?.path === target.path) {
        setSelectedWorkspace(null);
      }
    } catch (error) {
      console.error('Failed to remove from recent:', error);
    }
  };

  // Context menu handlers
  const handleContextMenu = (e: React.MouseEvent, workspace: WorkspaceInfo) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      workspace,
    });
  };

  const openRenameDialog = async (workspace: WorkspaceInfo) => {
    const canMoveResult = await window.electronAPI.projectMigration.canMove(workspace.path);
    if (!canMoveResult.canMove) {
      setOperationError(canMoveResult.reason || 'Cannot rename project');
      return;
    }

    let renameStats: WorkspaceStats | null = null;
    try {
      renameStats = await window.electronAPI.workspaceManager.getWorkspaceStats(workspace.path);
    } catch (e) {
      // Stats are optional, continue without them
    }

    setRenameDialog({
      visible: true,
      workspace,
      newName: workspace.name,
      error: null,
      stats: renameStats,
    });
  };

  const handleContextMenuAction = async (action: 'open' | 'rename' | 'move' | 'remove') => {
    const workspace = contextMenu.workspace;
    setContextMenu(prev => ({ ...prev, visible: false }));

    if (!workspace) return;

    switch (action) {
      case 'open':
        await window.electronAPI.workspaceManager.openWorkspace(workspace.path);
        break;

      case 'rename':
        await openRenameDialog(workspace);
        break;

      case 'move':
        await handleMoveProject(workspace);
        break;

      case 'remove':
        await handleRemoveFromRecent(workspace);
        break;
    }
  };

  const handleMoveProject = async (workspace: WorkspaceInfo) => {
    // Check if can move first
    const canMoveResult = await window.electronAPI.projectMigration.canMove(workspace.path);
    if (!canMoveResult.canMove) {
      setOperationError(canMoveResult.reason || 'Cannot move project');
      return;
    }

    // Open directory picker
    const result = await window.electronAPI.workspaceManager.openFolderDialog();
    if (!result.success || !result.path) return;

    // Construct the new path (destination + current project name)
    const projectName = workspace.name;
    const newPath = `${result.path}/${projectName}`;

    // Get workspace stats for the confirmation dialog
    let stats: WorkspaceStats | null = null;
    try {
      stats = await window.electronAPI.workspaceManager.getWorkspaceStats(workspace.path);
    } catch (e) {
      // Stats are optional, continue without them
    }

    // Show confirmation dialog
    setConfirmDialog({
      visible: true,
      type: 'move',
      workspace,
      destinationPath: newPath,
      stats,
    });
  };

  const executeMoveProject = async () => {
    if (!confirmDialog.workspace || !confirmDialog.destinationPath) return;

    const workspace = confirmDialog.workspace;
    const newPath = confirmDialog.destinationPath;

    setConfirmDialog(prev => ({ ...prev, visible: false }));
    setOperationLabel('Moving project...');
    setOperationInProgress(true);
    setOperationError(null);

    try {
      const moveResult = await window.electronAPI.projectMigration.move(workspace.path, newPath);
      if (moveResult.success) {
        await loadWorkspaces();
        // Update selected workspace if it was the one that moved
        if (selectedWorkspace?.path === workspace.path && moveResult.newPath) {
          const updatedWorkspaces = await window.electronAPI.workspaceManager.getRecentWorkspaces();
          const movedWorkspace = updatedWorkspaces.find((w: WorkspaceInfo) => w.path === moveResult.newPath);
          if (movedWorkspace) {
            setSelectedWorkspace(movedWorkspace);
          }
        }
      } else {
        setOperationError(moveResult.error || 'Failed to move project');
      }
    } catch (error: any) {
      setOperationError(error.message || 'Failed to move project');
    } finally {
      setOperationInProgress(false);
    }
  };

  const handleRenameSubmit = async () => {
    if (!renameDialog.workspace || !renameDialog.newName.trim()) return;

    const newName = renameDialog.newName.trim();

    // Validate name
    if (newName === renameDialog.workspace.name) {
      setRenameDialog(prev => ({ ...prev, visible: false }));
      return;
    }

    // Check for invalid characters
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(newName)) {
      setRenameDialog(prev => ({
        ...prev,
        error: 'Name contains invalid characters',
      }));
      return;
    }

    setOperationLabel('Renaming project...');
    setOperationInProgress(true);
    setRenameDialog(prev => ({ ...prev, error: null }));

    try {
      const result = await window.electronAPI.projectMigration.rename(
        renameDialog.workspace.path,
        newName
      );

      if (result.success) {
        setRenameDialog({ visible: false, workspace: null, newName: '', error: null, stats: null });
        await loadWorkspaces();
        // Update selected workspace if it was the one that was renamed
        if (selectedWorkspace?.path === renameDialog.workspace.path && result.newPath) {
          const updatedWorkspaces = await window.electronAPI.workspaceManager.getRecentWorkspaces();
          const renamedWorkspace = updatedWorkspaces.find((w: WorkspaceInfo) => w.path === result.newPath);
          if (renamedWorkspace) {
            setSelectedWorkspace(renamedWorkspace);
          }
        }
      } else {
        setRenameDialog(prev => ({
          ...prev,
          error: result.error || 'Failed to rename project',
        }));
      }
    } catch (error: any) {
      setRenameDialog(prev => ({
        ...prev,
        error: error.message || 'Failed to rename project',
      }));
    } finally {
      setOperationInProgress(false);
    }
  };

  const formatDate = (timestamp: number | string | undefined) => {
    if (!timestamp) {
      return 'Unknown';
    }

    // Convert string to number if needed
    let ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp;

    // If timestamp is in seconds (Unix timestamp), convert to milliseconds
    // Unix timestamps are typically 10 digits, JS timestamps are 13
    if (ts && ts < 10000000000) {
      ts = ts * 1000;
    }

    if (!ts || isNaN(ts) || ts === 0) {
      return 'Unknown';
    }

    const date = new Date(ts);

    // Check if date is valid
    if (isNaN(date.getTime())) {
      return 'Never';
    }

    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (days < 0) {
      return date.toLocaleDateString();
    } else if (days === 0) {
      return 'Today';
    } else if (days === 1) {
      return 'Yesterday';
    } else if (days < 7) {
      return `${days} days ago`;
    } else if (days < 30) {
      const weeks = Math.floor(days / 7);
      return `${weeks} week${weeks > 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString();
    }
  };

  const formatSize = (bytes: number) => {
    // Validate bytes
    if (!bytes || isNaN(bytes) || bytes < 0) {
      return '0 B';
    }

    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (filteredWorkspaces.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(prev => {
          const next = prev < filteredWorkspaces.length - 1 ? prev + 1 : prev;
          if (next !== -1) {
            setSelectedWorkspace(filteredWorkspaces[next]);
          }
          return next;
        });
        break;

      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(prev => {
          const next = prev > 0 ? prev - 1 : 0;
          setSelectedWorkspace(filteredWorkspaces[next]);
          return next;
        });
        break;

      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < filteredWorkspaces.length) {
          const workspace = filteredWorkspaces[highlightedIndex];
          window.electronAPI.workspaceManager.openWorkspace(workspace.path);
        } else if (selectedWorkspace) {
          handleOpenWorkspace();
        }
        break;

      case 'Escape':
        e.preventDefault();
        setSearchQuery('');
        setHighlightedIndex(-1);
        break;
    }
  };

  return (
    <div className="workspace-manager flex w-full h-screen overflow-hidden bg-[var(--nim-bg)] pt-[38px] before:content-[''] before:fixed before:top-0 before:left-0 before:right-0 before:h-[38px] before:[-webkit-app-region:drag] before:z-[1000]">
      <div className="sidebar w-[380px] bg-[var(--nim-bg-secondary)] border-r border-[var(--nim-border)] flex flex-col shrink-0">
        <div className="sidebar-header p-3 bg-[var(--nim-bg)] border-b border-[var(--nim-border)] [-webkit-app-region:no-drag]">
          <div className="app-branding flex items-center gap-2.5 mb-4">
            <img src="./icon.png" alt="Nimbalyst" className="app-logo w-8 h-8 shrink-0 object-contain" />
            <h2 className="m-0 text-lg font-bold text-[var(--nim-text)] tracking-tight">Nimbalyst</h2>
          </div>
          <div className="action-buttons flex gap-2">
            <button className="btn nim-btn-primary" onClick={handleBrowse}>
              Open Folder
            </button>
            <button className="btn nim-btn-secondary" onClick={handleCreateWorkspace}>
              New Folder
            </button>
          </div>
        </div>

        <div className="workspaces-list nim-scrollbar flex-1 overflow-y-auto overflow-x-hidden p-2 [-webkit-app-region:no-drag] flex flex-col">
          {!loading && workspaces.length > 0 && (
            <div className="search-container pb-2 shrink-0">
              <input
                type="text"
                className="workspace-search nim-input"
                placeholder="Search projects..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
              />
            </div>
          )}

          {loading ? (
            <div className="loading p-8 text-center">
              <div className="spinner w-6 h-6 border-2 border-[var(--nim-border)] border-t-[var(--nim-primary)] rounded-full animate-spin mx-auto"></div>
            </div>
          ) : workspaces.length === 0 ? (
            <div className="sidebar-empty flex flex-col items-center justify-center h-full p-5 text-center">
              <p className="text-[13px] text-[var(--nim-text-faint)] m-0">No recent projects</p>
            </div>
          ) : filteredWorkspaces.length === 0 ? (
            <div className="sidebar-empty flex flex-col items-center justify-center h-full p-5 text-center">
              <p className="text-[13px] text-[var(--nim-text-faint)] m-0">No matching projects</p>
            </div>
          ) : (
            filteredWorkspaces.map((workspace, index) => (
              <div
                key={workspace.path}
                className={`workspace-item flex gap-2 py-1.5 px-2 mb-0.5 rounded cursor-pointer transition-colors duration-100 border-none items-center hover:bg-[var(--nim-bg-hover)] ${selectedWorkspace?.path === workspace.path ? 'selected bg-[var(--nim-bg-selected)]' : ''} ${highlightedIndex === index ? 'highlighted bg-[var(--nim-bg-hover)]' : ''} ${highlightedIndex === index && selectedWorkspace?.path === workspace.path ? '!bg-[var(--nim-bg-selected-hover)]' : ''}`}
                onClick={(e) => {
                  // Command/Ctrl + click to deselect
                  if (e.metaKey || e.ctrlKey) {
                    if (selectedWorkspace?.path === workspace.path) {
                      setSelectedWorkspace(null);
                    }
                  } else {
                    setSelectedWorkspace(workspace);
                  }
                  setHighlightedIndex(index);
                }}
                onDoubleClick={handleOpenWorkspace}
                onContextMenu={(e) => handleContextMenu(e, workspace)}
              >
                <div className={`workspace-icon shrink-0 flex items-center justify-center text-[var(--nim-text-muted)] ${selectedWorkspace?.path === workspace.path ? '!text-[var(--nim-primary)]' : ''}`}>
                  <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>folder</span>
                </div>
                <div className="workspace-info flex-1 min-w-0">
                  <div className={`workspace-name text-[13px] font-medium text-[var(--nim-text)] mb-0.5 overflow-hidden text-ellipsis whitespace-nowrap ${selectedWorkspace?.path === workspace.path ? '!text-[var(--nim-primary)]' : ''}`}>{workspace.name}</div>
                  <div className="workspace-path text-[11px] text-[var(--nim-text-muted)] overflow-hidden text-ellipsis whitespace-nowrap mb-0.5">{workspace.path}</div>
                  <div className="workspace-meta flex gap-3 text-[11px] text-[var(--nim-text-faint)]">
                    {workspace.markdownCount !== undefined && (
                      <span className="whitespace-nowrap">{workspace.markdownCount} markdown files</span>
                    )}
                    <span className="whitespace-nowrap">{formatDate(workspace.lastOpened)}</span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="content flex-1 flex flex-col bg-[var(--nim-bg)] overflow-hidden">
        {selectedWorkspace ? (
          <>
            <div className="content-header py-5 px-6 border-b border-[var(--nim-border)] bg-[var(--nim-bg)] flex justify-between items-start gap-5">
              <div className="workspace-title">
                <h1 className="text-xl font-semibold text-[var(--nim-text)] m-0 mb-1">{selectedWorkspace.name}</h1>
                <div className="workspace-path text-[13px] text-[var(--nim-text-muted)]">{selectedWorkspace.path}</div>
              </div>
              <div className="content-actions flex flex-col items-end gap-2 shrink-0">
                <div className="content-actions-primary flex flex-wrap justify-end gap-2">
                  <button className="btn nim-btn-primary" onClick={handleOpenWorkspace}>
                    Open Project
                  </button>
                  <button className="btn nim-btn-secondary !text-[var(--nim-error)] !border-[var(--nim-error-subtle)] hover:!bg-[var(--nim-error-subtle)]" onClick={() => handleRemoveFromRecent()}>
                    Remove from Recent
                  </button>
                </div>
                <div className="content-actions-secondary flex flex-wrap justify-end gap-2">
                  <button
                    className="btn nim-btn-secondary !h-8 !px-2.5 !text-[12px]"
                    onClick={() => openRenameDialog(selectedWorkspace)}
                  >
                    Rename
                  </button>
                  <button
                    className="btn nim-btn-secondary !h-8 !px-2.5 !text-[12px]"
                    onClick={() => handleMoveProject(selectedWorkspace)}
                  >
                    Move
                  </button>
                </div>
              </div>
            </div>

            <div className="workspace-details nim-scrollbar flex-1 overflow-y-auto p-6 bg-[var(--nim-bg-secondary)]">
              {workspaceStats ? (
                <>
                  <div className="stats-grid grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
                    <div className="stat-card bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md p-4">
                      <div className="stat-value text-2xl font-semibold text-[var(--nim-text)] mb-1">{workspaceStats.fileCount}</div>
                      <div className="stat-label text-xs text-[var(--nim-text-muted)] uppercase tracking-wider">Total Files</div>
                    </div>
                    <div className="stat-card bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md p-4">
                      <div className="stat-value text-2xl font-semibold text-[var(--nim-text)] mb-1">{workspaceStats.markdownCount}</div>
                      <div className="stat-label text-xs text-[var(--nim-text-muted)] uppercase tracking-wider">Markdown Files</div>
                    </div>
                    <div className="stat-card bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md p-4">
                      <div className="stat-value text-2xl font-semibold text-[var(--nim-text)] mb-1">{formatSize(workspaceStats.totalSize)}</div>
                      <div className="stat-label text-xs text-[var(--nim-text-muted)] uppercase tracking-wider">Total Size</div>
                    </div>
                    <div className="stat-card bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md p-4">
                      <div className="stat-value text-2xl font-semibold text-[var(--nim-text)] mb-1">{formatDate(selectedWorkspace.lastOpened)}</div>
                      <div className="stat-label text-xs text-[var(--nim-text-muted)] uppercase tracking-wider">Last Opened</div>
                    </div>
                  </div>

                  {workspaceStats.recentFiles.length > 0 && (
                    <div className="recent-files bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md p-4 mt-4">
                      <h3 className="text-sm font-semibold text-[var(--nim-text)] m-0 mb-3">Recent Files</h3>
                      <ul className="list-none m-0 p-0">
                        {workspaceStats.recentFiles.map(file => (
                          <li key={file} className="flex items-center gap-2 py-1.5 text-[13px] text-[var(--nim-text-muted)] border-b border-[var(--nim-border-subtle)] last:border-b-0">
                            <span className="material-symbols-outlined text-base text-[var(--nim-text-faint)]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>description</span>
                            {file}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <div className="loading p-8 text-center">
                  <div className="spinner w-6 h-6 border-2 border-[var(--nim-border)] border-t-[var(--nim-primary)] rounded-full animate-spin mx-auto"></div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="welcome-container flex items-center justify-center h-full p-10 bg-gradient-to-br from-[#667eea] to-[#764ba2] relative overflow-hidden before:content-[''] before:absolute before:top-[-50%] before:right-[-50%] before:w-[200%] before:h-[200%] before:bg-[radial-gradient(circle,rgba(255,255,255,0.1)_0%,transparent_70%)] before:animate-[float_20s_ease-in-out_infinite]">
            <div className="welcome-content bg-white/[0.98] dark:bg-[var(--nim-bg)] rounded-2xl p-8 max-w-[500px] w-full shadow-[0_25px_50px_-12px_rgba(0,0,0,0.25)] backdrop-blur-[10px] relative z-[1]">
              <div className="welcome-header flex items-center justify-center gap-5 mb-6">
                <img src="./icon.png" alt="Nimbalyst" className="welcome-logo w-16 h-16 object-contain" />
                <div className="welcome-text text-left">
                  <h1 className="welcome-title text-[28px] font-extrabold text-[var(--nim-text)] m-0 mb-1 tracking-tight">Nimbalyst</h1>
                  <p className="welcome-subtitle text-sm text-[var(--nim-text-muted)] m-0 font-normal">AI-native, interactive work platform</p>
                </div>
              </div>

              <div className="welcome-info-compact mb-6 text-center">
                <p className="welcome-description text-sm text-[var(--nim-text-muted)] leading-relaxed m-0">
                  Projects are local folders on your computer. Open any folder to view and edit all markdown files within it.
                  If you are working on a coding project, it is recommended to open the root folder of your project as
                  agents are configured at the project level.
                </p>
              </div>

              <div className="welcome-actions flex justify-center gap-4">
                <button className="btn btn-large btn-welcome-primary bg-[var(--nim-primary)] text-white border-none py-3 px-6 text-[15px] font-semibold rounded-lg cursor-pointer transition-all duration-200 flex items-center justify-center gap-2 shadow-[0_2px_8px_rgba(59,130,246,0.3)] hover:bg-[var(--nim-primary-hover)] hover:shadow-[0_4px_12px_rgba(59,130,246,0.4)] hover:-translate-y-px" onClick={handleBrowse}>
                  <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>folder_open</span>
                  Open Folder
                </button>
                <button className="btn btn-large btn-welcome-secondary bg-[var(--nim-bg)] text-[var(--nim-text-muted)] border-2 border-[var(--nim-border)] py-3 px-6 text-[15px] font-semibold rounded-lg cursor-pointer transition-all duration-200 flex items-center justify-center gap-2 hover:bg-[var(--nim-bg-secondary)] hover:border-[var(--nim-border-hover)] hover:-translate-y-px" onClick={handleCreateWorkspace}>
                  <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>create_new_folder</span>
                  New Folder
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          className="fixed bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-lg py-1 min-w-[160px] z-[2000]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="w-full px-3 py-1.5 text-left text-[13px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] flex items-center gap-2"
            onClick={() => handleContextMenuAction('open')}
          >
            <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>folder_open</span>
            Open Project
          </button>
          <div className="border-t border-[var(--nim-border)] my-1" />
          <button
            className="w-full px-3 py-1.5 text-left text-[13px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] flex items-center gap-2"
            onClick={() => handleContextMenuAction('rename')}
          >
            <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>edit</span>
            Rename...
          </button>
          <button
            className="w-full px-3 py-1.5 text-left text-[13px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] flex items-center gap-2"
            onClick={() => handleContextMenuAction('move')}
          >
            <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>drive_file_move</span>
            Move to...
          </button>
          <div className="border-t border-[var(--nim-border)] my-1" />
          <button
            className="w-full px-3 py-1.5 text-left text-[13px] text-[var(--nim-error)] hover:bg-[var(--nim-bg-hover)] flex items-center gap-2"
            onClick={() => handleContextMenuAction('remove')}
          >
            <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>close</span>
            Remove from Recent
          </button>
        </div>
      )}

      {/* Rename Dialog */}
      {renameDialog.visible && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3000]">
          <div className="bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-lg shadow-xl p-5 w-[450px]">
            <h2 className="text-lg font-semibold text-[var(--nim-text)] m-0 mb-3">Rename Project</h2>

            {/* Warning banner */}
            <div className="bg-[var(--nim-warning)]/10 border border-[var(--nim-warning)]/30 rounded-md p-3 mb-4 flex gap-2">
              <span className="material-symbols-outlined text-[18px] text-[var(--nim-warning)] shrink-0 mt-0.5" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>warning</span>
              <div className="text-[12px] text-[var(--nim-text-muted)]">
                <p className="m-0 mb-1 font-medium text-[var(--nim-text)]">This will rename the project folder on disk</p>
                <p className="m-0">All AI session history, file history, and settings will be migrated. This may take a while for large projects.</p>
                {renameDialog.stats && (
                  <p className="m-0 mt-1 text-[var(--nim-text-faint)]">
                    Project size: {renameDialog.stats.fileCount.toLocaleString()} files, {formatSize(renameDialog.stats.totalSize)}
                  </p>
                )}
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-[13px] text-[var(--nim-text-muted)] mb-1">New name</label>
              <input
                ref={renameInputRef}
                type="text"
                className="nim-input w-full"
                value={renameDialog.newName}
                onChange={(e) => setRenameDialog(prev => ({ ...prev, newName: e.target.value, error: null }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !operationInProgress) {
                    handleRenameSubmit();
                  } else if (e.key === 'Escape') {
                    setRenameDialog({ visible: false, workspace: null, newName: '', error: null, stats: null });
                  }
                }}
                disabled={operationInProgress}
              />
              {renameDialog.error && (
                <p className="text-[12px] text-[var(--nim-error)] mt-1 m-0">{renameDialog.error}</p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                className="btn nim-btn-secondary"
                onClick={() => setRenameDialog({ visible: false, workspace: null, newName: '', error: null })}
                disabled={operationInProgress}
              >
                Cancel
              </button>
              <button
                className="btn nim-btn-primary"
                onClick={handleRenameSubmit}
                disabled={operationInProgress || !renameDialog.newName.trim()}
              >
                {operationInProgress ? 'Renaming...' : 'Rename'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Move Confirmation Dialog */}
      {confirmDialog.visible && confirmDialog.type === 'move' && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3000]">
          <div className="bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-lg shadow-xl p-5 w-[500px]">
            <h2 className="text-lg font-semibold text-[var(--nim-text)] m-0 mb-3">Move Project</h2>

            {/* Warning banner */}
            <div className="bg-[var(--nim-warning)]/10 border border-[var(--nim-warning)]/30 rounded-md p-3 mb-4 flex gap-2">
              <span className="material-symbols-outlined text-[18px] text-[var(--nim-warning)] shrink-0 mt-0.5" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>warning</span>
              <div className="text-[12px] text-[var(--nim-text-muted)]">
                <p className="m-0 mb-1 font-medium text-[var(--nim-text)]">This will move the entire project folder</p>
                <p className="m-0">All project files will be copied to the new location, and all AI session history, file history, and settings will be migrated. This may take a while for large projects.</p>
              </div>
            </div>

            <div className="mb-4 space-y-2">
              <div>
                <label className="block text-[12px] text-[var(--nim-text-muted)] mb-0.5">From</label>
                <div className="text-[13px] text-[var(--nim-text)] bg-[var(--nim-bg-secondary)] px-3 py-2 rounded border border-[var(--nim-border)] font-mono overflow-hidden text-ellipsis">{confirmDialog.workspace?.path}</div>
              </div>
              <div>
                <label className="block text-[12px] text-[var(--nim-text-muted)] mb-0.5">To</label>
                <div className="text-[13px] text-[var(--nim-text)] bg-[var(--nim-bg-secondary)] px-3 py-2 rounded border border-[var(--nim-border)] font-mono overflow-hidden text-ellipsis">{confirmDialog.destinationPath}</div>
              </div>
              {confirmDialog.stats && (
                <div className="flex gap-4 pt-2 text-[12px] text-[var(--nim-text-muted)]">
                  <span>{confirmDialog.stats.fileCount.toLocaleString()} files</span>
                  <span>{formatSize(confirmDialog.stats.totalSize)}</span>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                className="btn nim-btn-secondary"
                onClick={() => setConfirmDialog(prev => ({ ...prev, visible: false }))}
              >
                Cancel
              </button>
              <button
                className="btn nim-btn-primary"
                onClick={executeMoveProject}
              >
                Move Project
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Operation Error Toast */}
      {operationError && (
        <div className="fixed bottom-4 right-4 bg-[var(--nim-error)] text-white px-4 py-3 rounded-lg shadow-lg z-[3000] flex items-center gap-3 max-w-[400px]">
          <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>error</span>
          <span className="text-[13px] flex-1">{operationError}</span>
          <button
            className="text-white/80 hover:text-white"
            onClick={() => setOperationError(null)}
          >
            <span className="material-symbols-outlined text-[18px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 20" }}>close</span>
          </button>
        </div>
      )}

      {/* Loading Overlay */}
      {operationInProgress && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-[4000]">
          <div className="bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-lg shadow-xl p-6 flex items-center gap-3">
            <div className="spinner w-5 h-5 border-2 border-[var(--nim-border)] border-t-[var(--nim-primary)] rounded-full animate-spin"></div>
            <span className="text-[14px] text-[var(--nim-text)]">{operationLabel}</span>
          </div>
        </div>
      )}

      <style>{`
        @keyframes float {
          0%, 100% { transform: translate(0, 0) rotate(0deg); }
          33% { transform: translate(-30px, -30px) rotate(120deg); }
          66% { transform: translate(30px, -20px) rotate(240deg); }
        }
      `}</style>
    </div>
  );
};
