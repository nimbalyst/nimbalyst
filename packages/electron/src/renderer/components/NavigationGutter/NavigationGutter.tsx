import React, { useState, useCallback, useRef } from 'react';
import { usePostHog } from 'posthog-js/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { ContentMode } from '../../types/WindowModeTypes';
import type { SettingsCategory } from '../Settings/SettingsSidebar';
import type { SettingsScope } from '../Settings/SettingsView';
import { KeyboardShortcuts, getShortcutDisplay } from '../../../shared/KeyboardShortcuts';
import { ThemeToggleButton } from '../ThemeToggleButton/ThemeToggleButton';
import { SyncStatusButton } from '../SyncStatusButton/SyncStatusButton';
import { TrustIndicator } from '../TrustIndicator';
import { ExtensionDevIndicator } from '../ExtensionDevIndicator';
import { ClaudeUsageIndicator } from '../ClaudeUsageIndicator';
import { CodexUsageIndicator } from '../CodexUsageIndicator';
import { GeminiUsageIndicator } from '../GeminiUsageIndicator';
import { BackgroundTaskIndicator } from '../BackgroundTaskIndicator';
import { VoiceModeButton } from '../UnifiedAI/VoiceModeButton';
import { useExtensionGutterButtons, useExtensionBottomPanelButtons } from '../../extensions/panels/usePanels';
import { HelpTooltip } from '../../help';
import { setActiveSessionAtom } from '../../store';
import {
  developerModeAtom,
  terminalFeatureAvailableAtom,
  syncEnabledAtom,
  syncEnabledProjectsAtom,
} from '../../store/atoms/appSettings';
import { workspaceHasTeamAtom } from '../../store/atoms/collabDocuments';
import { stytchIsSignedInAtom } from '../../store/atoms/stytchAuth';
import { AlphaBadge } from '../common/AlphaBadge';
import { UserMenuPopover } from './UserMenuPopover';
import { GutterContextMenu } from './GutterContextMenu';
import { type HideableGutterButton, hiddenGutterButtonsAtom } from '../../store/atoms/projectState';
import { prRemoteAtom } from '../../store/atoms/pullRequests';

export type NavigationMode = 'planning' | 'coding';
export type SidebarView = 'files' | 'settings';

/**
 * Extension panel info for gutter buttons.
 */
export interface ExtensionPanelButton {
  id: string;
  icon: string;
  label: string;
  placement: 'sidebar' | 'fullscreen';
}

interface NavigationGutterProps {
  contentMode: ContentMode;
  onContentModeChange: (mode: ContentMode) => void;
  onOpenHistory?: () => void;
  onOpenSettings?: () => void;
  onNavigateSettings?: (scope: SettingsScope, category?: SettingsCategory) => void;
  onOpenPermissions?: () => void;
  onOpenFeedback?: () => void;
  onChangeTrustMode?: () => void;
  onToggleTerminalPanel?: () => void;
  terminalPanelVisible?: boolean;
  workspacePath?: string | null;
  /** Currently active extension panel ID */
  activeExtensionPanel?: string | null;
  /** Callback when an extension panel is activated */
  onExtensionPanelChange?: (panelId: string | null) => void;
  /** Callback to toggle Files mode sidebar collapsed state */
  onToggleFilesCollapsed?: () => void;
  /** Callback to toggle Agent mode session history collapsed state */
  onToggleAgentCollapsed?: () => void;
  /** Callback to toggle Collab mode (Shared Docs) sidebar collapsed state */
  onToggleCollabCollapsed?: () => void;
  /** Currently active extension bottom panel ID */
  activeExtensionBottomPanel?: string | null;
  /** Callback when an extension bottom panel is toggled */
  onExtensionBottomPanelChange?: (panelId: string | null) => void;
}

interface NavButton {
  id: string;
  icon: string;
  label: string;
  contentMode?: ContentMode;
  onClick?: () => void;
  badge?: number;
}

export const NavigationGutter: React.FC<NavigationGutterProps> = ({
  contentMode,
  onContentModeChange,
  onOpenHistory,
  onOpenSettings,
  onNavigateSettings,
  onOpenPermissions,
  onOpenFeedback,
  onChangeTrustMode,
  onToggleTerminalPanel,
  terminalPanelVisible,
  workspacePath,
  activeExtensionPanel,
  onExtensionPanelChange,
  onToggleFilesCollapsed,
  onToggleAgentCollapsed,
  onToggleCollabCollapsed,
  activeExtensionBottomPanel,
  onExtensionBottomPanelChange,
}) => {
  const posthog = usePostHog();
  const isDevMode = import.meta.env.DEV || window.IS_DEV_MODE;
  const developerMode = useAtomValue(developerModeAtom);
  const setActiveSession = useSetAtom(setActiveSessionAtom);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuButtonRef = useRef<HTMLButtonElement>(null);

  // Stytch auth state comes from the central atom (see stytchAuthListeners).
  // `null` means "still loading" -- treated as signed-in for icon purposes so
  // we don't flash the logged-out look during startup.
  const isSignedIn = useAtomValue(stytchIsSignedInAtom);

  // Gutter button visibility
  const hiddenButtons = useAtomValue(hiddenGutterButtonsAtom);
  const isHidden = useCallback((id: HideableGutterButton) => hiddenButtons.includes(id), [hiddenButtons]);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targetButton?: HideableGutterButton;
  } | null>(null);

  const openContextMenu = useCallback((e: React.MouseEvent, targetButton?: HideableGutterButton) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, targetButton });
  }, []);

  const handleNavigateSettings = useCallback((scope: SettingsScope, category?: SettingsCategory) => {
    if (onNavigateSettings) {
      onNavigateSettings(scope, category);
    } else {
      // Fallback: just open settings mode
      onOpenSettings?.();
    }
  }, [onNavigateSettings, onOpenSettings]);

  // Check if terminal feature is available (developer mode + feature enabled)
  const isTerminalAvailable = useAtomValue(terminalFeatureAvailableAtom);

  // Show the collab mode button whenever the workspace has an active team.
  const hasTeam = useAtomValue(workspaceHasTeamAtom);

  // Only show the PR review button when the active workspace has a GitHub
  // remote (detected by pullRequestListeners). Guard on workspacePath so a
  // stale remote from a previous project doesn't surface the button.
  const prRemote = useAtomValue(prRemoteAtom);
  const hasPrRemote =
    developerMode &&
    !!prRemote &&
    !!workspacePath &&
    prRemote.workspacePath === workspacePath;

  // Check if mobile sync is configured for this workspace
  const syncEnabled = useAtomValue(syncEnabledAtom);
  const syncEnabledProjects = useAtomValue(syncEnabledProjectsAtom);
  const isSyncConfigured = syncEnabled && !!workspacePath && syncEnabledProjects.includes(workspacePath);

  // User is "connected" to this project if they have a team or mobile sync configured
  const isProjectConnected = hasTeam || isSyncConfigured;

  // When sync is enabled but the user isn't signed in (creds missing/expired),
  // surface a logged-out indicator on the user button so the broken-sync state
  // isn't silent. Wait for the auth state to load before flipping the icon to
  // avoid flashing the logged-out look during startup.
  const needsSignIn = syncEnabled && isSignedIn === false;

  // Get extension panel buttons from the panel registry
  const extensionPanelButtons = useExtensionGutterButtons();
  const extensionBottomPanelButtons = useExtensionBottomPanelButtons();
  // Content mode buttons - primary navigation (top)
  const contentModeButtonsTop: NavButton[] = [
    {
      id: 'files',
      icon: 'account_tree',
      label: `Files (${getShortcutDisplay(KeyboardShortcuts.view.filesMode)})`,
      contentMode: 'files',
    },
    {
      id: 'manage',
      icon: 'folder_managed',
      label: 'Manage',
      contentMode: 'manage',
    },
  ];

  // Content mode buttons - agent section (after spacer)
  const contentModeButtonsAgent: NavButton[] = [
    {
      id: 'agent',
      icon: 'code',
      label: `Agent (${getShortcutDisplay(KeyboardShortcuts.view.agentMode)})`,
      contentMode: 'agent',
    },
  ];

  // Content mode buttons - tracker section
  const contentModeButtonsTracker: NavButton[] = [
    {
      id: 'tracker-mode',
      icon: 'assignment',
      label: `Tracker (${getShortcutDisplay(KeyboardShortcuts.view.trackerMode)})`,
      contentMode: 'tracker',
    },
  ];

  // Content mode buttons - PR review section
  const contentModeButtonsPrReview: NavButton[] = [
    {
      id: 'pr-review-mode',
      icon: 'merge',
      label: `Pull Requests (${getShortcutDisplay(KeyboardShortcuts.view.prReviewMode)})`,
      contentMode: 'pr-review',
    },
  ];

  // Content mode buttons - collab section
  const contentModeButtonsCollab: NavButton[] = [
    {
      id: 'collab-mode',
      icon: 'cloud_sync',
      label: `Shared Docs (${getShortcutDisplay(KeyboardShortcuts.view.collabMode)})`,
      contentMode: 'collab',
    },
  ];

  // Quick access buttons - secondary actions (middle)
  const quickAccessButtons: NavButton[] = [
    // Session History removed - use Cmd+Y for file history instead
  ];

  // Bottom panel buttons - positioned above settings
  // Terminal button is only shown if the terminal feature is available (developer mode + feature enabled)
  const bottomPanelButtons: NavButton[] = [
    // Only include terminal button if the feature is available
    ...(isTerminalAvailable ? [{
      id: 'terminal',
      icon: 'terminal',
      label: 'Terminal (Ctrl+`)',
      onClick: onToggleTerminalPanel,
    }] : []),
  ];

  // Feedback button
  const feedbackButton: NavButton = {
    id: 'feedback',
    icon: 'feedback',
    label: 'Send Feedback',
  };

  const handleButtonClick = (button: NavButton) => {
    // console.log('[NavigationGutter] Button clicked:', button.id, {
    //   hasOnClick: !!button.onClick,
    //   hasContentMode: !!button.contentMode,
    //   currentContentMode: contentMode,
    //   targetContentMode: button.contentMode
    // });

    if (button.contentMode) {
      // Track mode switch analytics
      if (button.contentMode !== contentMode) {
        posthog?.capture('content_mode_switched', {
          fromMode: contentMode,
          toMode: button.contentMode,
        });
      }
      // console.log('[NavigationGutter] Changing content mode from', contentMode, 'to', button.contentMode);
      onContentModeChange(button.contentMode);
    } else if (button.onClick) {
      // console.log('[NavigationGutter] Calling onClick for:', button.id);
      button.onClick();
    } else {
      console.warn('[NavigationGutter] No action defined for button:', button.id);
    }
  };

  return (
    <div className="navigation-gutter w-12 h-screen bg-nim-secondary border-r border-nim flex flex-col items-center py-2 shrink-0" onContextMenu={(e) => {
      // Only open background context menu if right-clicking empty space (not a button)
      if ((e.target as HTMLElement).closest('button, [data-panel-id]')) return;
      openContextMenu(e);
    }}>
      {/* Content Mode Switcher - Top Group (Files) */}
      <div className="nav-section nav-content-modes flex flex-col items-center gap-1 w-full px-1.5 py-1">
        {contentModeButtonsTop.map((button) => {
          const testId = `${button.id}-mode-button`;
          return (
            <HelpTooltip key={button.id} testId={testId} placement="right">
              <button
                className={`nav-button relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${contentMode === button.contentMode && !activeExtensionPanel ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`}
                onClick={() => {
                  // Clear any active fullscreen extension panel when switching to a content mode
                  onExtensionPanelChange?.(null);
                  if (contentMode === button.contentMode && !activeExtensionPanel) {
                    // Already on this mode - toggle collapse
                    if (button.contentMode === 'files') {
                      onToggleFilesCollapsed?.();
                    }
                  } else {
                    // Switch modes
                    handleButtonClick(button);
                  }
                }}
                aria-label={button.label}
                aria-pressed={contentMode === button.contentMode && !activeExtensionPanel}
                data-mode={button.contentMode || button.id}
                data-testid={testId}
              >
                <MaterialSymbol
                  icon={button.icon}
                  size={20}
                  fill={contentMode === button.contentMode && !activeExtensionPanel}
                />
                {button.badge !== undefined && button.badge > 0 && (
                  <span className="nav-badge absolute top-0.5 right-0.5 min-w-4 h-4 px-1 bg-nim-error text-white rounded-full text-[10px] font-semibold flex items-center justify-center leading-none pointer-events-none">{button.badge}</span>
                )}
              </button>
            </HelpTooltip>
          );
        })}
      </div>

      {/* Content Mode Switcher - Agent Group (Agent) */}
      <div className="nav-section nav-content-modes flex flex-col items-center gap-1 w-full px-1.5 py-1">
        {contentModeButtonsAgent.map((button) => {
          const testId = `${button.id}-mode-button`;
          return (
            <HelpTooltip key={button.id} testId={testId} placement="right">
              <button
                className={`nav-button relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${contentMode === button.contentMode && !activeExtensionPanel ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`}
                onClick={() => {
                  // Clear any active fullscreen extension panel when switching to a content mode
                  onExtensionPanelChange?.(null);
                  if (contentMode === button.contentMode && !activeExtensionPanel) {
                    // Already on this mode - toggle collapse
                    if (button.contentMode === 'agent') {
                      onToggleAgentCollapsed?.();
                    }
                  } else {
                    // Switch modes
                    handleButtonClick(button);
                  }
                }}
                aria-pressed={contentMode === button.contentMode && !activeExtensionPanel}
                data-mode={button.contentMode || button.id}
                data-testid={testId}
              >
                <MaterialSymbol
                  icon={button.icon}
                  size={20}
                  fill={contentMode === button.contentMode && !activeExtensionPanel}
                />
                {button.badge !== undefined && button.badge > 0 && (
                  <span className="nav-badge absolute top-0.5 right-0.5 min-w-4 h-4 px-1 bg-nim-error text-white rounded-full text-[10px] font-semibold flex items-center justify-center leading-none pointer-events-none">{button.badge}</span>
                )}
              </button>
            </HelpTooltip>
          );
        })}
      </div>

      {/* Content Mode Switcher - Tracker Group */}
      <div className="nav-section nav-content-modes flex flex-col items-center gap-1 w-full px-1.5 py-1">
        {contentModeButtonsTracker.map((button) => {
          const testId = `${button.id}-button`;
          return (
            <HelpTooltip key={button.id} testId={testId} placement="right">
              <button
                className={`nav-button relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${contentMode === button.contentMode && !activeExtensionPanel ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`}
                onClick={() => {
                  // Clear any active fullscreen extension panel when switching to a content mode
                  onExtensionPanelChange?.(null);
                  handleButtonClick(button);
                }}
                aria-pressed={contentMode === button.contentMode && !activeExtensionPanel}
                data-mode={button.contentMode || button.id}
                data-testid={testId}
              >
                <MaterialSymbol
                  icon={button.icon}
                  size={20}
                  fill={contentMode === button.contentMode && !activeExtensionPanel}
                />
              </button>
            </HelpTooltip>
          );
        })}
      </div>

      {/* Content Mode Switcher - PR Review Group - only shown when workspace has a GitHub remote */}
      {hasPrRemote && (
        <div className="nav-section nav-content-modes flex flex-col items-center gap-1 w-full px-1.5 py-1">
          {contentModeButtonsPrReview.map((button) => {
            const testId = `${button.id}-button`;
            return (
              <HelpTooltip key={button.id} testId={testId} placement="right">
                <button
                  className={`nav-button relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${contentMode === button.contentMode && !activeExtensionPanel ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`}
                  onClick={() => {
                    onExtensionPanelChange?.(null);
                    handleButtonClick(button);
                  }}
                  aria-pressed={contentMode === button.contentMode && !activeExtensionPanel}
                  data-mode={button.contentMode || button.id}
                  data-testid={testId}
                >
                  <MaterialSymbol
                    icon={button.icon}
                    size={20}
                    fill={contentMode === button.contentMode && !activeExtensionPanel}
                  />
                </button>
              </HelpTooltip>
            );
          })}
        </div>
      )}

      {/* Content Mode Switcher - Collab Group (Shared Docs) - only shown when workspace has a team */}
      {hasTeam && (
        <div className="nav-section nav-content-modes flex flex-col items-center gap-1 w-full px-1.5 py-1">
          {contentModeButtonsCollab.map((button) => {
            const testId = `${button.id}-button`;
            return (
              <HelpTooltip key={button.id} testId={testId} placement="right">
                <button
                  className={`nav-button relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${contentMode === button.contentMode && !activeExtensionPanel ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`}
                  onClick={() => {
                    // Clear any active fullscreen extension panel when switching to a content mode
                    onExtensionPanelChange?.(null);
                    if (contentMode === button.contentMode && !activeExtensionPanel) {
                      // Already on this mode - toggle collapse
                      if (button.contentMode === 'collab') {
                        onToggleCollabCollapsed?.();
                      }
                    } else {
                      // Switch modes
                      handleButtonClick(button);
                    }
                  }}
                  aria-pressed={contentMode === button.contentMode && !activeExtensionPanel}
                  data-mode={button.contentMode || button.id}
                  data-testid={testId}
                >
                  <MaterialSymbol
                    icon={button.icon}
                    size={20}
                    fill={contentMode === button.contentMode && !activeExtensionPanel}
                  />
                  <AlphaBadge
                    size="dot"
                    className="absolute top-0 right-0.5 pointer-events-none"
                  />
                </button>
              </HelpTooltip>
            );
          })}
        </div>
      )}

      {/* Fullscreen Extension Panels - appear below Agent as additional modes */}
      {extensionPanelButtons.filter(p => p.placement === 'fullscreen').length > 0 && (
        <div className="nav-section nav-extension-modes flex flex-col items-center gap-1 w-full px-1.5 py-1 pt-2 mt-1 border-t border-nim">
          {extensionPanelButtons
            .filter(panel => panel.placement === 'fullscreen')
            .map((panel) => (
              <button
                key={panel.id}
                className={`nav-button relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${activeExtensionPanel === panel.id ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`}
                onClick={() => {
                  const newPanelId = activeExtensionPanel === panel.id ? null : panel.id;
                  onExtensionPanelChange?.(newPanelId);
                  posthog?.capture('extension_panel_toggled', {
                    panelId: panel.id,
                    placement: panel.placement,
                    action: newPanelId ? 'activated' : 'deactivated',
                  });
                }}
                title={panel.label}
                aria-label={panel.label}
                aria-pressed={activeExtensionPanel === panel.id}
                data-panel-id={panel.id}
              >
                <MaterialSymbol
                  icon={panel.icon}
                  size={20}
                  fill={activeExtensionPanel === panel.id}
                />
                {panel.isAlpha && (
                  <AlphaBadge size="dot" className="absolute top-0 right-0.5 pointer-events-none" />
                )}
              </button>
            ))}
        </div>
      )}

      {/* Quick Access */}
      <div className="nav-section nav-quick-access flex flex-col items-center gap-1 w-full px-1.5 py-1 flex-1 pt-2">
        {quickAccessButtons.map((button) => (
          <button
            key={button.id}
            className="nav-button relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md text-nim-muted cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary hover:text-nim active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2"
            onClick={() => handleButtonClick(button)}
            title={button.label}
            aria-label={button.label}
          >
            <MaterialSymbol icon={button.icon} size={20} />
            {button.badge !== undefined && button.badge > 0 && (
              <span className="nav-badge absolute top-0.5 right-0.5 min-w-4 h-4 px-1 bg-nim-error text-white rounded-full text-[10px] font-semibold flex items-center justify-center leading-none pointer-events-none">{button.badge}</span>
            )}
          </button>
        ))}
      </div>

      {/* Extension Panels - Sidebar panels only (fullscreen panels are in top modes section) */}
      {extensionPanelButtons.filter(p => p.placement === 'sidebar').length > 0 && (
        <div className="nav-section nav-extension-panels flex flex-col items-center gap-1 w-full px-1.5 py-1">
          {extensionPanelButtons
            .filter(panel => panel.placement === 'sidebar')
            .map((panel) => (
              <button
                key={panel.id}
                className={`nav-button relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${activeExtensionPanel === panel.id ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`}
                onClick={() => {
                  // Toggle panel: if clicking active panel, deactivate it
                  const newPanelId = activeExtensionPanel === panel.id ? null : panel.id;
                  onExtensionPanelChange?.(newPanelId);
                  // Sidebar panels work alongside files mode
                  if (newPanelId && contentMode !== 'files') {
                    onContentModeChange('files');
                  }
                  posthog?.capture('extension_panel_toggled', {
                    panelId: panel.id,
                    placement: panel.placement,
                    action: newPanelId ? 'activated' : 'deactivated',
                  });
                }}
                title={panel.label}
                aria-label={panel.label}
                data-panel-id={panel.id}
              >
                <MaterialSymbol
                  icon={panel.icon}
                  size={20}
                  fill={activeExtensionPanel === panel.id}
                />
                {panel.isAlpha && (
                  <AlphaBadge size="dot" className="absolute top-0 right-0.5 pointer-events-none" />
                )}
              </button>
            ))}
        </div>
      )}

      {/* Voice Mode - persistent button with integrated context ring */}
      {!isHidden('voice-mode') && (
        <div className="nav-section nav-voice-mode flex flex-col items-center gap-1 w-full px-1.5 py-1" onContextMenu={(e) => openContextMenu(e, 'voice-mode')}>
          <VoiceModeButton workspacePath={workspacePath} />
        </div>
      )}

      {/* Bottom Panel Toggles - Above Settings */}
      <div className="nav-section nav-bottom-panels flex flex-col items-center gap-1 w-full px-1.5 py-1">
        {bottomPanelButtons.map((button) => {
          const isActive = button.id === 'terminal' && terminalPanelVisible;
          const testId = `${button.id}-panel-button`;
          return (
            <HelpTooltip key={button.id} testId={testId} placement="right">
              <button
                className={`nav-button relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${isActive ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`}
                onClick={() => handleButtonClick(button)}
                aria-label={button.label}
                data-testid={testId}
              >
                <MaterialSymbol icon={button.icon} size={20} fill={isActive} />
              </button>
            </HelpTooltip>
          );
        })}
        {extensionBottomPanelButtons.map((panel) => {
          const isActive = activeExtensionBottomPanel === panel.id;
          const testId = `extension-bottom-panel-${panel.id}`;
          return (
            <HelpTooltip key={panel.id} testId={testId} placement="right">
              <button
                className={`nav-button relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${isActive ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`}
                onClick={() => {
                  const newPanelId = isActive ? null : panel.id;
                  onExtensionBottomPanelChange?.(newPanelId);
                  posthog?.capture('extension_panel_toggled', {
                    panelId: panel.id,
                    placement: 'bottom',
                    action: newPanelId ? 'activated' : 'deactivated',
                  });
                }}
                title={panel.label}
                aria-label={panel.label}
                aria-pressed={isActive}
                data-testid={testId}
                data-panel-id={panel.id}
              >
                <MaterialSymbol icon={panel.icon} size={20} fill={isActive} />
                {panel.isAlpha && (
                  <AlphaBadge size="dot" className="absolute top-0 right-0.5 pointer-events-none" />
                )}
              </button>
            </HelpTooltip>
          );
        })}
      </div>



      {/* Settings (bottom) */}
      <div className="nav-section nav-settings flex flex-col items-center gap-1 w-full px-1.5 py-1 mt-auto pt-2 border-t border-nim">

        {/* Claude Usage Indicator - Shows API usage limits */}
        {!isHidden('claude-usage') && (
          <div onContextMenu={(e) => openContextMenu(e, 'claude-usage')}>
            <ClaudeUsageIndicator />
          </div>
        )}

        {/* Codex Usage Indicator - Shows Codex subscription usage limits */}
        {!isHidden('codex-usage') && (
          <div onContextMenu={(e) => openContextMenu(e, 'codex-usage')}>
            <CodexUsageIndicator />
          </div>
        )}

        {/* Gemini Usage Indicator - Shows Gemini (Antigravity) usage limits */}
        {!isHidden('gemini-usage') && (
          <div onContextMenu={(e) => openContextMenu(e, 'gemini-usage')}>
            <GeminiUsageIndicator />
          </div>
        )}

        {/* Extension Dev Indicator - Shows when extension dev tools are enabled */}
        {!isHidden('extension-dev') && (
          <div onContextMenu={(e) => openContextMenu(e, 'extension-dev')}>
            <ExtensionDevIndicator onOpenSettings={onOpenSettings} />
          </div>
        )}

        {isDevMode && (
          <BackgroundTaskIndicator
            workspacePath={workspacePath || undefined}
            onOpenSession={(sessionId) => {
              setActiveSession(sessionId);
              onContentModeChange('agent');
            }}
          />
        )}

        {/* Trust Indicator - Shows agent trust status */}
        {!isHidden('trust-indicator') && (
          <div onContextMenu={(e) => openContextMenu(e, 'trust-indicator')}>
            <TrustIndicator
              workspacePath={workspacePath}
              onOpenSettings={onOpenPermissions || (() => {})}
              onChangeMode={onChangeTrustMode}
            />
          </div>
        )}

        {/* Sync Status - Above Theme Toggle */}
        {!isHidden('sync-status') && (
          <div onContextMenu={(e) => openContextMenu(e, 'sync-status')}>
            <SyncStatusButton
              workspacePath={workspacePath || undefined}
              onOpenSettings={onOpenSettings}
            />
          </div>
        )}

        {/* Theme Toggle - Above Settings */}
        {!isHidden('theme-toggle') && (
          <div className="nav-section nav-theme flex flex-col items-center gap-1 w-full px-1.5 py-1" onContextMenu={(e) => openContextMenu(e, 'theme-toggle')}>
            <ThemeToggleButton />
          </div>
        )}

        {!isHidden('feedback') && (
          <HelpTooltip testId="gutter-feedback-button" placement="right">
            <button
              className="nimbalyst-feedback-button nav-button relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md text-nim-muted cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary hover:text-nim active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2"
              onClick={() => {
                // console.log('[NavigationGutter] Feedback button clicked');
                onOpenFeedback?.();
              }}
              onContextMenu={(e) => openContextMenu(e, 'feedback')}
              aria-label={feedbackButton.label}
              data-testid="gutter-feedback-button"
            >
              <MaterialSymbol
                icon={feedbackButton.icon}
                size={20}
              />
            </button>
          </HelpTooltip>
        )}

        <div>
          {userMenuOpen && (
            <UserMenuPopover
              onNavigateSettings={handleNavigateSettings}
              onClose={() => setUserMenuOpen(false)}
              isProjectConnected={isProjectConnected}
              anchorEl={userMenuButtonRef.current}
            />
          )}
          <HelpTooltip testId="gutter-user-button" placement="right">
            <button
              ref={userMenuButtonRef}
              className={`nav-button relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${userMenuOpen ? 'bg-nim-tertiary text-nim' : needsSignIn ? 'bg-transparent text-nim-warning hover:bg-nim-tertiary' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`}
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              aria-label={needsSignIn ? 'User menu (signed out -- sync requires sign in)' : 'User menu'}
              aria-expanded={userMenuOpen}
              data-signed-in={isSignedIn === null ? undefined : isSignedIn}
              data-needs-sign-in={needsSignIn || undefined}
              data-testid="gutter-user-button"
            >
              <MaterialSymbol
                icon={needsSignIn ? 'no_accounts' : 'person'}
                size={20}
              />
            </button>
          </HelpTooltip>
        </div>
      </div>

      {/* Gutter context menu */}
      {contextMenu && (
        <GutterContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          targetButton={contextMenu.targetButton}
          onClose={() => setContextMenu(null)}
          workspacePath={workspacePath || ''}
        />
      )}
    </div>
  );
};
