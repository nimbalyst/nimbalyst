import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { HelpTooltip } from '../../help';
import { syncStatusUpdateAtom } from '../../store/atoms/syncStatus';

export interface SyncConfig {
  enabled: boolean;
  serverUrl: string;
  userId: string;
  authToken: string;
  enabledProjects?: string[];
}

export interface SyncStats {
  sessionCount: number;
  lastSyncedAt: number | null;
}

export interface DocSyncStats {
  projectCount: number;
  fileCount: number;
  connected: boolean;
}

export interface SyncStatus {
  appConfigured: boolean;       // Is sync configured at the app level?
  projectEnabled: boolean;      // Is current project enabled for sync?
  connected: boolean;           // Is the connection active?
  syncing: boolean;             // Is a sync in progress?
  error: string | null;
  stats: SyncStats;
  docSyncStats?: DocSyncStats;  // Document file sync stats
  userEmail?: string | null;    // Logged in user's email
}

interface SyncStatusButtonProps {
  workspacePath?: string;
  onOpenSettings?: () => void;
}

export const SyncStatusButton: React.FC<SyncStatusButtonProps> = ({ workspacePath, onOpenSettings }) => {
  const [status, setStatus] = useState<SyncStatus>({
    appConfigured: false,
    projectEnabled: false,
    connected: false,
    syncing: false,
    error: null,
    stats: {
      sessionCount: 0,
      lastSyncedAt: null,
    },
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Fetch sync status (called once on mount and when workspace changes)
  const fetchStatus = useCallback(async () => {
    try {
      const result = await window.electronAPI.invoke('sync:get-status', workspacePath);
      if (result) {
        setStatus(result);
      }
    } catch (error) {
      console.error('[SyncStatusButton] Failed to fetch sync status:', error);
    }
  }, [workspacePath]);

  // Initial fetch and subscribe to status changes (no polling).
  // The IPC subscription lives in store/listeners/syncListeners.ts; we just
  // ensure the main process is broadcasting and rely on syncStatusUpdateAtom.
  useEffect(() => {
    fetchStatus();
    window.electronAPI.invoke('sync:subscribe-status');
  }, [fetchStatus]);

  // Apply incremental status updates broadcast via IPC.
  const syncStatusUpdate = useAtomValue(syncStatusUpdateAtom);
  useEffect(() => {
    if (!syncStatusUpdate) return;
    setStatus(prev => ({
      ...prev,
      connected: syncStatusUpdate.connected,
      syncing: syncStatusUpdate.syncing,
      error: syncStatusUpdate.error,
    }));
  }, [syncStatusUpdate]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuOpen &&
        menuRef.current &&
        buttonRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // Don't render if sync is not configured at all
  if (!status.appConfigured) {
    return null;
  }

  const handleToggleProjectSync = async () => {
    try {
      await window.electronAPI.invoke('sync:toggle-project', workspacePath, !status.projectEnabled);
      await fetchStatus();
    } catch (error) {
      console.error('[SyncStatusButton] Failed to toggle project sync:', error);
    }
  };

  const handleOpenSettings = () => {
    setMenuOpen(false);
    if (onOpenSettings) {
      onOpenSettings();
    }
  };

  const getStatusIcon = (): string => {
    if (!status.projectEnabled) {
      return 'cloud_off';
    }
    if (status.error) {
      return 'cloud_off';
    }
    if (status.syncing) {
      return 'cloud_sync';
    }
    if (status.connected) {
      return 'cloud_done';
    }
    return 'cloud_off';
  };

  const getStatusClass = (): string => {
    if (!status.projectEnabled) {
      return 'disabled';
    }
    if (status.error) {
      return 'error';
    }
    if (status.syncing) {
      return 'syncing';
    }
    if (status.connected) {
      return 'connected';
    }
    return 'disconnected';
  };

  const getButtonColorClass = (): string => {
    const statusClass = getStatusClass();
    if (statusClass === 'connected' || statusClass === 'syncing') {
      return 'text-[var(--nim-text-muted)]';
    }
    if (statusClass === 'disabled') {
      return 'text-[var(--nim-text-faint)] opacity-60';
    }
    // disconnected or error
    return 'text-[var(--nim-text-faint)]';
  };

  const getIndicatorColorClass = (): string => {
    const statusClass = getStatusClass();
    switch (statusClass) {
      case 'connected':
        return 'bg-[#22c55e]';
      case 'syncing':
        return 'bg-[#3b82f6] animate-pulse';
      case 'disconnected':
        return 'bg-[#f59e0b]';
      case 'error':
        return 'bg-[#ef4444]';
      case 'disabled':
        return 'bg-[var(--nim-text-faint)]';
      default:
        return '';
    }
  };

  const getBadgeColorClass = (): string => {
    const statusClass = getStatusClass();
    switch (statusClass) {
      case 'connected':
        return 'bg-[rgba(34,197,94,0.15)] text-[#22c55e]';
      case 'syncing':
        return 'bg-[rgba(59,130,246,0.15)] text-[#3b82f6]';
      case 'disconnected':
        return 'bg-[rgba(245,158,11,0.15)] text-[#f59e0b]';
      case 'error':
        return 'bg-[rgba(239,68,68,0.15)] text-[#ef4444]';
      case 'disabled':
        return 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)]';
      default:
        return '';
    }
  };

  const getStatusLabel = (): string => {
    if (!status.projectEnabled) {
      return 'Sync disabled for this project';
    }
    if (status.error) {
      return 'Sync error';
    }
    if (status.syncing) {
      return 'Syncing...';
    }
    if (status.connected) {
      return 'Sync connected';
    }
    return 'Sync disconnected';
  };

  const formatLastSync = (): string => {
    if (!status.stats.lastSyncedAt) {
      return 'Never';
    }
    const date = new Date(status.stats.lastSyncedAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) {
      return 'Just now';
    }
    if (diffMins < 60) {
      return `${diffMins}m ago`;
    }
    if (diffHours < 24) {
      return `${diffHours}h ago`;
    }
    return `${diffDays}d ago`;
  };

  return (
    <div className="sync-status-button-container relative">
      <HelpTooltip testId="gutter-sync-button" placement="right">
        <button
          ref={buttonRef}
          className={`sync-status-button nav-button relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${getButtonColorClass()}`}
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label={getStatusLabel()}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          data-testid="gutter-sync-button"
        >
          <MaterialSymbol icon={getStatusIcon()} size={20} />
          <span
            className={`sync-indicator absolute bottom-1 right-1 w-1.5 h-1.5 rounded-full border border-[var(--nim-bg-secondary)] ${getIndicatorColorClass()}`}
          />
        </button>
      </HelpTooltip>

      {menuOpen && (
        <div
          ref={menuRef}
          className="sync-menu absolute left-[calc(100%+8px)] bottom-0 min-w-[240px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.15)] z-[1000] overflow-hidden"
          role="menu"
        >
          <div className="sync-menu-header flex justify-between items-center px-3.5 py-3 bg-[var(--nim-bg-tertiary)] border-b border-[var(--nim-border)]">
            <span className="sync-menu-title text-[13px] font-semibold text-[var(--nim-text)]">
              Session Sync
            </span>
            <span
              className={`sync-status-badge text-[11px] font-medium px-2 py-0.5 rounded-[10px] ${getBadgeColorClass()}`}
            >
              {status.projectEnabled ? (status.connected ? 'Connected' : 'Disconnected') : 'Disabled'}
            </span>
          </div>

          {status.userEmail && (
            <div className="sync-menu-user flex items-center gap-2 px-3.5 py-2.5 border-b border-[var(--nim-border)] text-[var(--nim-text-muted)] text-xs">
              <MaterialSymbol icon="account_circle" size={16} />
              <span>{status.userEmail}</span>
            </div>
          )}

          {status.error && (
            <div className="sync-menu-error flex items-center gap-2 px-3.5 py-2.5 bg-[rgba(239,68,68,0.1)] text-[#ef4444] text-xs">
              <MaterialSymbol icon="error" size={16} />
              <span>{status.error}</span>
            </div>
          )}

          <div className="sync-menu-stats px-3.5 py-3">
            <div className="sync-stat flex justify-between items-center py-1">
              <span className="sync-stat-label text-xs text-[var(--nim-text-muted)]">Sessions synced</span>
              <span className="sync-stat-value text-xs font-medium text-[var(--nim-text)]">
                {status.stats.sessionCount}
              </span>
            </div>
            <div className="sync-stat flex justify-between items-center py-1">
              <span className="sync-stat-label text-xs text-[var(--nim-text-muted)]">Last sync</span>
              <span className="sync-stat-value text-xs font-medium text-[var(--nim-text)]">
                {formatLastSync()}
              </span>
            </div>
          </div>

          {status.docSyncStats && status.docSyncStats.fileCount > 0 && (
            <>
              <div className="sync-menu-divider h-px bg-[var(--nim-border)] m-0" />
              <div className="px-3.5 py-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <MaterialSymbol icon="description" size={14} className="text-[var(--nim-text-muted)]" />
                  <span className="text-[11px] font-semibold text-[var(--nim-text-muted)] uppercase tracking-wider">Document Sync</span>
                </div>
                <div className="sync-stat flex justify-between items-center py-1">
                  <span className="sync-stat-label text-xs text-[var(--nim-text-muted)]">Files tracked</span>
                  <span className="sync-stat-value text-xs font-medium text-[var(--nim-text)]">
                    {status.docSyncStats.fileCount}
                  </span>
                </div>
                <div className="sync-stat flex justify-between items-center py-1">
                  <span className="sync-stat-label text-xs text-[var(--nim-text-muted)]">Status</span>
                  <span className={`sync-stat-value text-xs font-medium ${status.docSyncStats.connected ? 'text-[#22c55e]' : 'text-[var(--nim-text-faint)]'}`}>
                    {status.docSyncStats.connected ? 'Connected' : 'Disconnected'}
                  </span>
                </div>
              </div>
            </>
          )}

          <div className="sync-menu-divider h-px bg-[var(--nim-border)] m-0" />

          <div className="sync-menu-actions p-1.5">
            <button
              className="sync-menu-action flex items-center gap-2.5 w-full px-2.5 py-2 bg-transparent border-none rounded-md text-[var(--nim-text)] text-[13px] text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleToggleProjectSync}
              role="menuitem"
            >
              <span className="text-[var(--nim-text-muted)]">
                <MaterialSymbol icon={status.projectEnabled ? 'toggle_on' : 'toggle_off'} size={18} />
              </span>
              <span>{status.projectEnabled ? 'Disable sync for this project' : 'Enable sync for this project'}</span>
            </button>
            <button
              className="sync-menu-action flex items-center gap-2.5 w-full px-2.5 py-2 bg-transparent border-none rounded-md text-[var(--nim-text)] text-[13px] text-left cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleOpenSettings}
              role="menuitem"
            >
              <span className="text-[var(--nim-text-muted)]">
                <MaterialSymbol icon="settings" size={18} />
              </span>
              <span>Sync settings</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
