/**
 * Trust Indicator
 *
 * Shows workspace trust status in the navigation gutter.
 * Uses Jotai atom family for workspace-scoped state that stays in sync
 * with ProjectPermissionsPanel.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  workspacePermissionsAtomFamily,
  loadWorkspacePermissions,
} from '../../store/atoms/appSettings';
import { permissionsChangedVersionAtom } from '../../store/atoms/permissions';
import { HelpTooltip } from '../../help';
import { getProjectTrustPresentation } from '../ProjectTrustToast/projectTrustChoices';

export interface TrustStatus {
  trustedAt?: number;
  permissionMode: 'ask' | 'allow-all' | 'bypass-all' | null;
  allowAllUsesClassifier: boolean;
}

interface TrustIndicatorProps {
  workspacePath?: string | null;
  onOpenSettings: () => void;
  onChangeMode?: () => void;
}

export const TrustIndicator: React.FC<TrustIndicatorProps> = ({
  workspacePath,
  onOpenSettings,
  onChangeMode,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Get the atom for this workspace (or a placeholder if no workspace)
  const permissionsAtom = useMemo(
    () => workspacePath ? workspacePermissionsAtomFamily(workspacePath) : null,
    [workspacePath]
  );
  const [permissionsState, setPermissionsState] = useAtom(
    permissionsAtom ?? workspacePermissionsAtomFamily('')
  );

  // Extract trust status from permissions state
  const status: TrustStatus | null = workspacePath
    ? {
        trustedAt: permissionsState.trustedAt,
        permissionMode: permissionsState.permissionMode,
        allowAllUsesClassifier: permissionsState.allowAllUsesClassifier,
      }
    : null;

  const loading = workspacePath ? permissionsState.loading : false;

  // Fetch trust status
  const fetchStatus = useCallback(async () => {
    if (!workspacePath) return;

    try {
      const state = await loadWorkspacePermissions(workspacePath);
      setPermissionsState(state);
    } catch (error) {
      console.error('[TrustIndicator] Failed to fetch trust status:', error);
    }
  }, [workspacePath, setPermissionsState]);

  // Re-fetch on initial mount and whenever the central permissions listener
  // (store/listeners/permissionListeners.ts) bumps the version counter.
  const permissionsVersion = useAtomValue(permissionsChangedVersionAtom);
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus, permissionsVersion]);

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

  // Don't render if no workspace
  if (!workspacePath) {
    return null;
  }

  const handleTrustWorkspace = async () => {
    try {
      await window.electronAPI.invoke('permissions:trustWorkspace', workspacePath);
      await fetchStatus();
      setMenuOpen(false);
    } catch (error) {
      console.error('[TrustIndicator] Failed to trust workspace:', error);
    }
  };

  const handleRevokeWorkspaceTrust = async () => {
    try {
      await window.electronAPI.invoke('permissions:revokeWorkspaceTrust', workspacePath);
      await fetchStatus();
      setMenuOpen(false);
    } catch (error) {
      console.error('[TrustIndicator] Failed to revoke workspace trust:', error);
    }
  };

  const handleOpenSettings = () => {
    setMenuOpen(false);
    onOpenSettings();
  };

  const handleChangeMode = async () => {
    if (!workspacePath) return;

    // Just close the menu and trigger the callback to show the toast
    // Don't revoke trust - that happens only if user picks a new mode
    setMenuOpen(false);
    onChangeMode?.();
  };

  const isTrusted = status?.permissionMode !== null && status?.permissionMode !== undefined;
  const currentPresentation =
    status && !loading && status.permissionMode !== null
      ? getProjectTrustPresentation(
          status.permissionMode,
          status.allowAllUsesClassifier,
        )
      : null;

  const getStatusIcon = (): string => {
    if (!status || loading) {
      return 'shield';
    }
    if (currentPresentation) {
      return currentPresentation.icon;
    }
    return 'gpp_maybe';
  };

  const getStatusClass = (): string => {
    if (!status || loading) {
      return 'loading';
    }
    if (currentPresentation) {
      return currentPresentation.choice;
    }
    return 'untrusted';
  };

  const getIndicatorColorClass = (): string => {
    switch (currentPresentation?.severity) {
      case 'primary':
        return 'text-[var(--nim-primary)]';
      case 'warning':
        return 'text-[var(--nim-warning)]';
      default:
        return !status || loading
          ? 'text-[var(--nim-text-faint)]'
          : 'text-[var(--nim-text-muted)]';
    }
  };

  const getDotColorClass = (): string => {
    switch (currentPresentation?.severity) {
      case 'primary':
        return 'bg-[var(--nim-primary)]';
      case 'warning':
        return 'bg-[var(--nim-warning)]';
      default:
        if (!status || loading) {
          return 'bg-[var(--nim-text-faint)]';
        }
        return isTrusted
          ? 'bg-[var(--nim-text-muted)]'
          : 'bg-[var(--nim-warning)]';
    }
  };

  const getCurrentModeClasses = (): string => {
    const base = 'mx-2 mb-2 p-3 rounded-md bg-[var(--nim-bg)] border border-[var(--nim-border)]';
    if (currentPresentation?.severity === 'warning' || !isTrusted) {
      return `${base} border-[var(--nim-warning)] bg-[color-mix(in_srgb,var(--nim-warning)_10%,transparent)]`;
    }
    return base;
  };

  const getModeValueColorClass = (): string => {
    switch (currentPresentation?.severity) {
      case 'primary':
        return 'text-[var(--nim-primary)]';
      case 'warning':
        return 'text-[var(--nim-warning)]';
      default:
        return isTrusted
          ? 'text-[var(--nim-text)]'
          : 'text-[var(--nim-warning)]';
    }
  };

  const getStatusLabel = (): string => {
    if (!status || loading) {
      return 'Loading trust status...';
    }
    if (currentPresentation) {
      return `${currentPresentation.label} mode`;
    }
    return 'Workspace not trusted for agent';
  };

  const getStatusDescription = (): string => {
    if (!status || loading) {
      return '';
    }
    if (currentPresentation) {
      return currentPresentation.description;
    }
    return 'Trust this workspace to allow the AI agent to run commands.';
  };

  return (
    <div className="trust-indicator-container relative">
      <HelpTooltip testId="gutter-permissions-button" placement="right">
        <button
          ref={buttonRef}
          className={`trust-indicator nav-button relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${getStatusClass()} ${getIndicatorColorClass()}`}
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label={getStatusLabel()}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          data-testid="gutter-permissions-button"
        >
          <MaterialSymbol icon={getStatusIcon()} size={20} />
          <span
            className={`trust-indicator-dot absolute bottom-1 right-1 w-2 h-2 rounded-full border-2 border-[var(--nim-bg-secondary)] ${getStatusClass()} ${getDotColorClass()}`}
          />
        </button>
      </HelpTooltip>

      {menuOpen && (
        <div
          ref={menuRef}
          className="trust-menu absolute bottom-0 left-[calc(100%+8px)] w-[280px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.15)] z-[100] animate-[trust-menu-appear_0.15s_ease-out]"
          role="menu"
          style={{
            // Inline keyframe animation fallback
            animation: 'trust-menu-appear 0.15s ease-out',
          }}
        >
          <style>{`
            @keyframes trust-menu-appear {
              from {
                opacity: 0;
                transform: translateX(-4px);
              }
              to {
                opacity: 1;
                transform: translateX(0);
              }
            }
          `}</style>
          <div className="trust-menu-header flex items-center justify-between px-3 pt-3 pb-2">
            <span className="trust-menu-title text-[13px] font-semibold text-[var(--nim-text)]">
              Agent Permissions
            </span>
          </div>

          {/* Current mode - prominent display */}
          <div className={`trust-menu-current-mode ${getStatusClass()} ${getCurrentModeClasses()}`}>
            <div className="trust-menu-current-mode-label text-[11px] font-medium text-[var(--nim-text-faint)] uppercase tracking-[0.5px] mb-1.5">
              Current mode:
            </div>
            <div className={`trust-menu-current-mode-value flex items-center gap-2 text-sm font-semibold mb-1 ${getModeValueColorClass()}`}>
              <MaterialSymbol
                icon={getStatusIcon()}
                size={20}
              />
              <span>
                {currentPresentation?.label ?? 'Not Trusted'}
              </span>
            </div>
            <div className="trust-menu-current-mode-description text-xs text-[var(--nim-text-muted)] leading-[1.4]">
              {getStatusDescription()}
            </div>
          </div>

          {status?.trustedAt && (
            <div className="trust-menu-date px-3 pb-2 text-[11px] text-[var(--nim-text-faint)]">
              Trusted {new Date(status.trustedAt).toLocaleDateString()}
            </div>
          )}

          <div className="trust-menu-divider h-px bg-[var(--nim-border)] my-1" />

          <div className="trust-menu-actions p-1">
              <button
                className="trust-menu-action flex items-center gap-2 w-full p-2 border-none bg-transparent text-[var(--nim-text)] text-[13px] font-inherit text-left rounded cursor-pointer transition-colors duration-100 hover:bg-[var(--nim-bg-hover)]"
                onClick={handleChangeMode}
                role="menuitem"
              >
                <MaterialSymbol icon="swap_horiz" size={18} className="text-[var(--nim-text-muted)]" />
                <span>Change permission mode</span>
              </button>
            <button
              className="trust-menu-action flex items-center gap-2 w-full p-2 border-none bg-transparent text-[var(--nim-text)] text-[13px] font-inherit text-left rounded cursor-pointer transition-colors duration-100 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleOpenSettings}
              role="menuitem"
            >
              <MaterialSymbol icon="settings" size={18} className="text-[var(--nim-text-muted)]" />
              <span>Permission settings</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
