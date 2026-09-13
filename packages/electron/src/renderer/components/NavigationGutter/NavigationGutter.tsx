import React, { useState, useCallback, useEffect, useRef } from 'react';
import { usePostHog } from 'posthog-js/react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { ContentMode } from '../../types/WindowModeTypes';
import type { SettingsCategory } from '../Settings/SettingsSidebar';
import type { SettingsScope } from '../Settings/SettingsView';
import { KeyboardShortcuts, getShortcutDisplay } from '../../../shared/KeyboardShortcuts';
import { ThemeToggleButton } from '../ThemeToggleButton/ThemeToggleButton';
import { TrustIndicator } from '../TrustIndicator';
import { ExtensionDevIndicator } from '../ExtensionDevIndicator';
import { ClaudeUsageIndicator } from '../ClaudeUsageIndicator';
import { CodexUsageIndicator } from '../CodexUsageIndicator';
import { GeminiUsageIndicator } from '../GeminiUsageIndicator';
import { VoiceModeButton } from '../UnifiedAI/VoiceModeButton';
import { useExtensionGutterButtons, useExtensionBottomPanelButtons } from '../../extensions/panels/usePanels';
import { openOrganizationSurface } from './openOrganizationSurface';
import { HelpTooltip } from '../../help';
import {
  developerModeAtom,
  terminalFeatureAvailableAtom,
  syncEnabledAtom,
} from '../../store/atoms/appSettings';
import {
  hiddenGutterItemsAtom,
  gutterItemOrderAtom,
  toggleGutterItemHiddenAtom,
  setGutterSectionOrderAtom,
  resetGutterCustomizationAtom,
} from '../../store/atoms/appSettings';
import { workspaceHasTeamAtom } from '../../store/atoms/collabDocuments';
import { stytchIsSignedInAtom } from '../../store/atoms/stytchAuth';
import { personalAccountsAtom } from '../../store/atoms/settingsDomains';
import { orgInboxUnreadCountAtomFamily } from '../../store/atoms/teamInbox';
import { formatUnreadCount } from '../../store/projectWindowUnreadViewModel';
import { useProjectOrg } from '../../hooks/useProjectOrg';
import { AlphaBadge } from '../common/AlphaBadge';
import { AccountInspectorPopover } from '../Accounts/AccountInspectorPopover';
import { summarizeSyncStatus } from '../Accounts/syncStatusSummary';
import { useSyncStatus } from '../../hooks/useSyncStatus';
import { GutterContextMenu } from './GutterContextMenu';
import { CustomizeGutterPopover } from './CustomizeGutterPopover';
import {
  type GutterItem,
  type GutterItemMeta,
  type GutterSection,
  sortBySavedOrder,
  canHideGutterItem,
} from './navGutterItems';
import { prRemoteAtom } from '../../store/atoms/pullRequests';
import { AgentSessionsPopover } from './AgentSessionsPopover';

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
  /** Callback to toggle Tracker mode sidebar collapsed state */
  onToggleTrackerCollapsed?: () => void;
  /** Callback to toggle Org mode sidebar collapsed state */
  onToggleOrgCollapsed?: () => void;
  /** Currently active extension bottom panel ID */
  activeExtensionBottomPanel?: string | null;
  /** Callback when an extension bottom panel is toggled */
  onExtensionBottomPanelChange?: (panelId: string | null) => void;
}

// Shared nav-button styling. `active` swaps the filled/primary look.
const NAV_BTN_BASE =
  'nav-button group relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2';
const navBtnClass = (active: boolean): string =>
  `${NAV_BTN_BASE} ${active ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`;

export const NavigationGutter: React.FC<NavigationGutterProps> = ({
  contentMode,
  onContentModeChange,
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
  onToggleTrackerCollapsed,
  onToggleOrgCollapsed,
  activeExtensionBottomPanel,
  onExtensionBottomPanelChange,
}) => {
  const posthog = usePostHog();
  const developerMode = useAtomValue(developerModeAtom);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuButtonRef = useRef<HTMLButtonElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // Stytch auth state comes from the central atom (see stytchAuthListeners).
  // `null` means "still loading" -- treated as signed-in for icon purposes so
  // we don't flash the logged-out look during startup.
  const isSignedIn = useAtomValue(stytchIsSignedInAtom);
  const accounts = useAtomValue(personalAccountsAtom);

  // Organization for the active project — feeds the popover's Organization and
  // Messages rows.
  const { org: projectOrg, loading: projectOrgLoading } = useProjectOrg(workspacePath);
  const projectOrgUnread = useAtomValue(
    orgInboxUnreadCountAtomFamily(projectOrg?.orgId ?? ''),
  );
  // Global gutter customization (visibility + per-section order).
  const hiddenItems = useAtomValue(hiddenGutterItemsAtom);
  const sectionOrder = useAtomValue(gutterItemOrderAtom);
  const toggleHidden = useSetAtom(toggleGutterItemHiddenAtom);
  const setSectionOrder = useSetAtom(setGutterSectionOrderAtom);
  const resetCustomization = useSetAtom(resetGutterCustomizationAtom);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targetButton?: string;
  } | null>(null);
  // Customize popover state (anchored at the click point).
  const [customizeAnchor, setCustomizeAnchor] = useState<{ x: number; y: number } | null>(null);

  const openContextMenu = useCallback((e: React.MouseEvent, targetButton?: string) => {
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

  // When sync is enabled but the user isn't signed in (creds missing/expired),
  // surface a logged-out indicator on the user button so the broken-sync state
  // isn't silent. Wait for the auth state to load before flipping the icon to
  // avoid flashing the logged-out look during startup.
  const needsSignIn = syncEnabled && isSignedIn === false;

  // Sync state for the account popover's Sync row. It used to have its own
  // gutter slot; the state now reaches the user through the avatar, which
  // already carries the sign-in warning, so there is one place to look when
  // something about the account needs attention rather than two.
  const syncStatus = useSyncStatus(workspacePath || undefined);
  const syncSummary = summarizeSyncStatus(syncStatus);
  const accountNeedsAttention = needsSignIn || (syncSummary?.needsAttention ?? false);

  // Get extension panel buttons from the panel registry
  const extensionPanelButtons = useExtensionGutterButtons();
  const extensionBottomPanelButtons = useExtensionBottomPanelButtons();

  // ── Content-mode button render helper ───────────────────────────────────
  const renderModeButton = (opts: {
    icon: string;
    label: string;
    contentMode: ContentMode;
    testId: string;
    /** Re-clicking the already-active mode (e.g. toggle sidebar collapse). */
    onReclick?: () => void;
    /** Small glyph badged into the icon's lower-right corner (e.g. "shared with people"). */
    badgeIcon?: string;
    /** Extra decoration (e.g. alpha badge). */
    decoration?: React.ReactNode;
    /** Interactive sibling rendered over the button (e.g. Agent attention bubble). */
    overlay?: React.ReactNode;
  }): React.ReactNode => {
    const isActive = contentMode === opts.contentMode && !activeExtensionPanel;
    return (
      <div className="nav-mode-button-wrapper relative">
        <HelpTooltip testId={opts.testId} placement="right">
          <button
            className={navBtnClass(isActive)}
            onClick={() => {
              // Clear any active fullscreen extension panel when switching modes.
              onExtensionPanelChange?.(null);
              if (isActive) {
                opts.onReclick?.();
              } else {
                if (opts.contentMode !== contentMode) {
                  posthog?.capture('content_mode_switched', {
                    fromMode: contentMode,
                    toMode: opts.contentMode,
                  });
                }
                onContentModeChange(opts.contentMode);
              }
            }}
            aria-label={opts.label}
            aria-pressed={isActive}
            data-mode={opts.contentMode}
            data-testid={opts.testId}
          >
            <MaterialSymbol icon={opts.icon} size={20} fill={isActive} />
            {opts.badgeIcon && (
              // The disc tracks the button's own background so the badge glyph
              // stays legible where it overlaps the main icon, in every state.
              <span
                className={`nav-mode-button-badge absolute bottom-[3px] right-[3px] flex items-center justify-center rounded-full p-[1px] pointer-events-none ${
                  isActive
                    ? 'bg-nim-primary group-hover:bg-nim-primary-hover'
                    : 'bg-nim-secondary group-hover:bg-nim-tertiary'
                }`}
                aria-hidden="true"
              >
                <MaterialSymbol icon={opts.badgeIcon} size={12} fill />
              </span>
            )}
            {opts.decoration}
          </button>
        </HelpTooltip>
        {opts.overlay}
      </div>
    );
  };

  // ── Extension panel render helpers ──────────────────────────────────────
  const renderExtensionPanelButton = (
    panel: { id: string; icon: string; label: string; placement: 'sidebar' | 'fullscreen'; isAlpha: boolean },
  ): React.ReactNode => {
    const isActive = activeExtensionPanel === panel.id;
    return (
      <button
        className={navBtnClass(isActive)}
        onClick={() => {
          const newPanelId = isActive ? null : panel.id;
          // Sidebar panels work alongside files mode.
          if (panel.placement === 'sidebar' && newPanelId && contentMode !== 'files') {
            onContentModeChange('files');
          }
          // Mode navigation dismisses panels; open the requested panel after it.
          onExtensionPanelChange?.(newPanelId);
          posthog?.capture('extension_panel_toggled', {
            panelId: panel.id,
            placement: panel.placement,
            action: newPanelId ? 'activated' : 'deactivated',
          });
        }}
        title={panel.label}
        aria-label={panel.label}
        aria-pressed={isActive}
        data-panel-id={panel.id}
      >
        <MaterialSymbol icon={panel.icon} size={20} fill={isActive} />
        {panel.isAlpha && (
          <AlphaBadge size="dot" className="absolute top-0 right-0.5 pointer-events-none" />
        )}
      </button>
    );
  };

  const renderBottomPanelButton = (
    panel: { id: string; icon: string; label: string; isAlpha: boolean },
  ): React.ReactNode => {
    const isActive = activeExtensionBottomPanel === panel.id;
    const testId = `extension-bottom-panel-${panel.id}`;
    return (
      <HelpTooltip testId={testId} placement="right">
        <button
          className={navBtnClass(isActive)}
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
  };

  // ── Build the declarative registry ──────────────────────────────────────
  // Only AVAILABLE items are added (capability gating). Order within a section
  // is applied at render time from the saved per-section order.
  const modeItems: GutterItem[] = [
    {
      id: 'files', section: 'modes', icon: 'account_tree', label: 'Files', hideable: true,
      render: () => renderModeButton({
        icon: 'account_tree',
        label: `Files (${getShortcutDisplay(KeyboardShortcuts.view.filesMode)})`,
        contentMode: 'files', testId: 'files-mode-button',
        onReclick: () => onToggleFilesCollapsed?.(),
      }),
    },
    {
      id: 'agent', section: 'modes', icon: 'code', label: 'Agent', hideable: true,
      render: () => renderModeButton({
        icon: 'code',
        label: `Agent (${getShortcutDisplay(KeyboardShortcuts.view.agentMode)})`,
        contentMode: 'agent', testId: 'agent-mode-button',
        onReclick: () => onToggleAgentCollapsed?.(),
        overlay: <AgentSessionsPopover onOpenAgentMode={() => onContentModeChange('agent')} />,
      }),
    },
    {
      id: 'tracker', section: 'modes', icon: 'assignment', label: 'Tracker', hideable: true,
      render: () => renderModeButton({
        icon: 'assignment',
        label: `Tracker (${getShortcutDisplay(KeyboardShortcuts.view.trackerMode)})`,
        contentMode: 'tracker', testId: 'tracker-mode-button',
        onReclick: () => onToggleTrackerCollapsed?.(),
      }),
    },
    ...(hasPrRemote ? [{
      id: 'pr-review', section: 'modes' as GutterSection, icon: 'merge', label: 'GitHub', hideable: true,
      render: () => renderModeButton({
        icon: 'merge',
        label: `GitHub (${getShortcutDisplay(KeyboardShortcuts.view.prReviewMode)})`,
        contentMode: 'pr-review', testId: 'pr-review-mode-button',
      }),
    }] : []),
    ...(hasTeam ? [{
      id: 'collab', section: 'modes' as GutterSection, icon: 'description', label: 'Shared Docs', hideable: true,
      render: () => renderModeButton({
        icon: 'description',
        badgeIcon: 'groups',
        label: `Shared Docs (${getShortcutDisplay(KeyboardShortcuts.view.collabMode)})`,
        contentMode: 'collab', testId: 'collab-mode-button',
        onReclick: () => onToggleCollabCollapsed?.(),
        decoration: <AlphaBadge size="dot" className="absolute top-0 right-0.5 pointer-events-none" />,
      }),
    }] : []),
    // Org mode is gated on the project actually belonging to an organization,
    // the same rule Shared Docs uses. Without one there is no inbox to show.
    ...(projectOrg ? [{
      id: 'org', section: 'modes' as GutterSection, icon: 'forum', label: 'Organization', hideable: true,
      render: () => renderModeButton({
        icon: 'forum',
        label: `Organization (${getShortcutDisplay(KeyboardShortcuts.view.orgMode)})${
          projectOrgUnread > 0 ? `, ${projectOrgUnread} unread` : ''
        }`,
        contentMode: 'org', testId: 'org-mode-button',
        onReclick: () => onToggleOrgCollapsed?.(),
        decoration: (
          <>
            <AlphaBadge size="dot" className="absolute top-0 right-0.5 pointer-events-none" />
            {projectOrgUnread > 0 && (
              // Same bubble the Agent gutter button uses, moved to the lower
              // corner so it does not sit on top of the beta dot. The count is
              // the mode's whole discoverability story, so it lives here rather
              // than only inside a popover.
              <span
                className="org-mode-unread-bubble absolute -bottom-1.5 -right-1.5 z-10 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-[var(--nim-bg-secondary)] bg-nim-error px-1 text-[10px] font-bold leading-none text-white shadow-sm pointer-events-none"
                aria-hidden="true"
                data-testid="org-mode-unread"
              >
                {formatUnreadCount(projectOrgUnread)}
              </span>
            )}
          </>
        ),
      }),
    }] : []),
  ];

  const panelItems: GutterItem[] = [
    // Fullscreen extension panels (view switchers), then sidebar toggles.
    ...extensionPanelButtons
      .filter((p) => p.placement === 'fullscreen')
      .map((panel): GutterItem => ({
        id: panel.id, section: 'panels', icon: panel.icon, label: panel.label, hideable: true,
        render: () => renderExtensionPanelButton(panel),
      })),
    ...extensionPanelButtons
      .filter((p) => p.placement === 'sidebar')
      .map((panel): GutterItem => ({
        id: panel.id, section: 'panels', icon: panel.icon, label: panel.label, hideable: true,
        render: () => renderExtensionPanelButton(panel),
      })),
    ...(isTerminalAvailable ? [{
      id: 'terminal', section: 'panels' as GutterSection, icon: 'terminal', label: 'Terminal', hideable: true,
      render: () => (
        <HelpTooltip testId="terminal-panel-button" placement="right">
          <button
            className={navBtnClass(!!terminalPanelVisible)}
            onClick={() => onToggleTerminalPanel?.()}
            aria-label="Terminal (Ctrl+`)"
            data-testid="terminal-panel-button"
          >
            <MaterialSymbol icon="terminal" size={20} fill={!!terminalPanelVisible} />
          </button>
        </HelpTooltip>
      ),
    }] : []),
    ...extensionBottomPanelButtons.map((panel): GutterItem => ({
      id: panel.id, section: 'panels', icon: panel.icon, label: panel.label, hideable: true,
      render: () => renderBottomPanelButton(panel),
    })),
  ];

  const indicatorItems: GutterItem[] = [
    {
      id: 'voice-mode', section: 'indicators', icon: 'mic', label: 'Voice Mode', hideable: true,
      render: () => <VoiceModeButton workspacePath={workspacePath} />,
    },
    {
      id: 'claude-usage', section: 'indicators', icon: 'speed', label: 'Claude Usage', hideable: true,
      render: () => <ClaudeUsageIndicator />,
    },
    {
      id: 'codex-usage', section: 'indicators', icon: 'speed', label: 'Codex Usage', hideable: true,
      render: () => <CodexUsageIndicator />,
    },
    {
      id: 'gemini-usage', section: 'indicators', icon: 'gemini', label: 'Gemini Usage', hideable: true,
      render: () => <GeminiUsageIndicator />,
    },
    {
      id: 'extension-dev', section: 'indicators', icon: 'extension', label: 'Extension Dev', hideable: true,
      render: () => <ExtensionDevIndicator onOpenSettings={onOpenSettings} />,
    },
    {
      id: 'trust-indicator', section: 'indicators', icon: 'verified_user', label: 'Permissions', hideable: true,
      render: () => (
        <TrustIndicator
          workspacePath={workspacePath}
          onOpenSettings={onOpenPermissions || (() => {})}
          onChangeMode={onChangeTrustMode}
        />
      ),
    },
    {
      id: 'theme-toggle', section: 'indicators', icon: 'dark_mode', label: 'Theme Toggle', hideable: true,
      render: () => <ThemeToggleButton />,
    },
    {
      id: 'feedback', section: 'indicators', icon: 'feedback', label: 'Feedback', hideable: true,
      render: () => (
        <HelpTooltip testId="gutter-feedback-button" placement="right">
          <button
            className={`nimbalyst-feedback-button ${NAV_BTN_BASE} bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim`}
            onClick={() => onOpenFeedback?.()}
            aria-label="Send Feedback"
            data-testid="gutter-feedback-button"
          >
            <MaterialSymbol icon="feedback" size={20} />
          </button>
        </HelpTooltip>
      ),
    },
  ];

  // All available items, and just the metadata (for the context menu / popover).
  const registry: GutterItem[] = [...modeItems, ...panelItems, ...indicatorItems];
  const registryMeta: GutterItemMeta[] = registry.map(({ id, section, icon, label, hideable }) => ({
    id, section, icon, label, hideable,
  }));
  const modeIds = modeItems.map((m) => m.id);

  const canHide = useCallback(
    (id: string): boolean => {
      const meta = registryMeta.find((m) => m.id === id);
      if (!meta) return false;
      return canHideGutterItem(id, meta, modeIds, hiddenItems);
    },
    // registryMeta / modeIds are recomputed each render; hiddenItems drives the guard.
    [hiddenItems],
  );

  const handleToggleHidden = useCallback((id: string) => {
    // Hiding is guarded (keep-one-mode / non-hideable); showing is always allowed.
    if (hiddenItems.includes(id) || canHide(id)) {
      toggleHidden({ id });
    }
  }, [hiddenItems, canHide, toggleHidden]);

  // Render one section: available items, in saved order, minus hidden ones.
  // Each item is wrapped so a right-click targets it in the context menu.
  const renderSection = (items: GutterItem[], section: GutterSection): React.ReactNode => {
    const ordered = sortBySavedOrder(items, sectionOrder[section]);
    const visible = ordered.filter((it) => !hiddenItems.includes(it.id));
    return visible.map((it) => (
      <div
        key={it.id}
        data-gutter-item={it.id}
        onContextMenu={(e) => openContextMenu(e, it.id)}
      >
        {it.render()}
      </div>
    ));
  };

  return (
    <div
      ref={gutterRef}
      className="navigation-gutter w-12 h-full bg-nim-secondary border-r border-nim flex flex-col items-center py-2 shrink-0"
      onContextMenu={(e) => {
        // Only open the background context menu on empty space (not a button/item).
        if ((e.target as HTMLElement).closest('button, [data-panel-id], [data-gutter-item]')) return;
        openContextMenu(e);
      }}
    >
      {/* Navigation Modes (top) */}
      <div className="nav-section nav-content-modes flex flex-col items-center gap-1 w-full px-1.5 py-1">
        {renderSection(modeItems, 'modes')}
      </div>

      {/* Spacer pushes panels + indicators to the lower half */}
      <div className="nav-section nav-quick-access flex flex-col items-center gap-1 w-full px-1.5 py-1 flex-1 pt-2" />

      {/* Panels (extension panels + terminal) */}
      {panelItems.length > 0 && (
        <div className="nav-section nav-extension-panels flex flex-col items-center gap-1 w-full px-1.5 py-1">
          {renderSection(panelItems, 'panels')}
        </div>
      )}

      {/* Indicators + settings cluster (bottom) */}
      <div className="nav-section nav-settings flex flex-col items-center gap-1 w-full px-1.5 py-1 mt-auto pt-2 border-t border-nim">
        {renderSection(indicatorItems, 'indicators')}

        {/* User menu: always visible, never hideable, always last */}
        <div>
          {userMenuOpen && (
            <AccountInspectorPopover
              accounts={accounts}
              projectOrg={projectOrg}
              projectOrgLoading={projectOrgLoading}
              onAddProjectToOrganization={() => {
                setUserMenuOpen(false);
                handleNavigateSettings('project', 'project-sharing');
              }}
              anchorEl={userMenuButtonRef.current}
              onClose={() => setUserMenuOpen(false)}
              onOpenAccount={() => {
                setUserMenuOpen(false);
                handleNavigateSettings('account', 'account');
              }}
              onOpenApplicationSettings={() => {
                setUserMenuOpen(false);
                handleNavigateSettings('application');
              }}
              onOpenProjectSettings={() => {
                setUserMenuOpen(false);
                handleNavigateSettings('project');
              }}
              onManageOrganization={(orgId) => {
                setUserMenuOpen(false);
                openOrganizationSurface(orgId, workspacePath);
              }}
              messagesUnreadCount={projectOrgUnread}
              onOpenMessages={(orgId) => {
                setUserMenuOpen(false);
                if (projectOrg?.orgId === orgId) {
                  onContentModeChange('org');
                }
              }}
              sync={syncSummary}
              onOpenSyncSettings={() => {
                setUserMenuOpen(false);
                // Per-project sync selection lives in the Mobile App panel.
                handleNavigateSettings('account', 'account-mobile');
              }}
            />
          )}
          <HelpTooltip testId="gutter-user-button" placement="right">
            <button
              ref={userMenuButtonRef}
              className={`account-inspector-trigger nav-button relative w-9 h-9 flex items-center justify-center border-none rounded-md cursor-pointer transition-all duration-150 p-0 active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2 ${userMenuOpen ? 'bg-nim-tertiary text-nim' : accountNeedsAttention ? 'bg-transparent text-nim-warning hover:bg-nim-tertiary' : 'bg-transparent text-nim-muted hover:bg-nim-tertiary hover:text-nim'}`}
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              aria-label={
                needsSignIn
                  ? 'User menu (signed out -- sync requires sign in)'
                  : syncSummary?.needsAttention
                    ? `User menu (sync: ${syncSummary.detail})`
                    : 'User menu'
              }
              aria-expanded={userMenuOpen}
              data-signed-in={isSignedIn === null ? undefined : isSignedIn}
              data-needs-sign-in={needsSignIn || undefined}
              data-sync-attention={syncSummary?.needsAttention || undefined}
              data-testid="gutter-user-button"
            >
              {accounts.length > 0 ? (
                <>
                  <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-white ${accountNeedsAttention ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-warning)]' : 'bg-[var(--nim-primary)]'}`}>
                    {(accounts.find((account) => account.isSyncAccount)?.email?.[0] ?? accounts[0]?.email?.[0] ?? '?').toUpperCase()}
                  </span>
                  {accounts.length > 1 && <span className="absolute -bottom-0.5 -right-0.5 rounded-full border border-[var(--nim-border)] bg-[var(--nim-bg-tertiary)] px-1 text-[8px] font-semibold leading-3">{accounts.length}</span>}
                </>
              ) : <MaterialSymbol icon={needsSignIn ? 'no_accounts' : 'person'} size={20} />}
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
          items={registryMeta}
          hiddenIds={hiddenItems}
          canHide={canHide}
          onToggleHidden={handleToggleHidden}
          onReset={resetCustomization}
          onOpenCustomize={() => {
            setCustomizeAnchor({ x: contextMenu.x, y: contextMenu.y });
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Customize gutter popover */}
      {customizeAnchor && (
        <CustomizeGutterPopover
          x={customizeAnchor.x}
          y={customizeAnchor.y}
          items={registryMeta}
          hiddenIds={hiddenItems}
          sectionOrder={sectionOrder}
          canHide={canHide}
          onToggleHidden={handleToggleHidden}
          onReorder={(section, order) => setSectionOrder({ section, order })}
          onReset={resetCustomization}
          onClose={() => setCustomizeAnchor(null)}
        />
      )}
    </div>
  );
};
