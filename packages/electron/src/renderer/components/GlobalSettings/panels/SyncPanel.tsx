import React, { useState, useEffect, useRef } from 'react';
import { usePostHog } from 'posthog-js/react';
import { useAtom, useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { QRPairingModal } from './QRPairingModal';
import {
  syncConfigAtom,
  setSyncConfigAtom,
  releaseChannelAtom,
  advancedSettingsAtom,
  setAdvancedSettingsAtom,
  type SyncConfig,
} from '../../../store/atoms/appSettings';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';
import { SettingsToggle } from '../SettingsToggle';

/** Format a timestamp as relative time (e.g., "5 minutes ago") */
function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) {
    return 'just now';
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }

  return new Date(timestamp).toLocaleDateString();
}

// SyncConfig is now exported from appSettings.ts
// Re-export for backward compatibility
export type { SyncConfig } from '../../../store/atoms/appSettings';

interface Project {
  path: string;
  name: string;
}

interface DeviceInfo {
  deviceId: string;
  name: string;
  type: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  platform: string;
  appVersion?: string;
  connectedAt: number;
  lastActiveAt: number;
  isOnline?: boolean;
  lastSeenAt?: number;
}

// NOTE: Props have been removed - SyncPanel now uses Jotai atoms directly.
// The component is self-contained and doesn't need external config management.

interface StytchAuthState {
  isAuthenticated: boolean;
  user: {
    user_id: string;
    emails: Array<{ email: string }>;
    name?: { first_name?: string; last_name?: string };
  } | null;
}

function SharingCallout() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
      <div className="p-3.5 bg-nim-primary/8 border border-nim-primary/20 rounded-lg">
        <div className="flex items-start gap-2.5">
          <MaterialSymbol icon="share" size={18} className="text-[var(--nim-primary)] shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[13px] font-semibold text-[var(--nim-text)]">
                Sharing Sessions & Documents
              </span>
              <button
                className="inline-flex items-center justify-center w-[18px] h-[18px] p-0 border-none rounded-full bg-[var(--nim-bg-tertiary)] cursor-pointer hover:bg-[var(--nim-bg-active)] transition-colors"
                onClick={() => setExpanded(!expanded)}
                title={expanded ? 'Hide details' : 'How does sharing work?'}
              >
                <MaterialSymbol icon={expanded ? 'expand_less' : 'help'} size={14} className="text-[var(--nim-text-muted)]" />
              </button>
            </div>
            <p className="m-0 text-[12px] text-[var(--nim-text-muted)] leading-relaxed">
              Right-click any session or document to create an encrypted share link for collaborators.
            </p>
          </div>
        </div>
        {expanded && (
          <div className="mt-3 pt-3 border-t border-nim-primary/15">
            <ul className="m-0 pl-5 text-[12px] text-[var(--nim-text-muted)] leading-7 list-disc">
              <li>In <strong className="text-[var(--nim-text)]">Agent mode</strong>, right-click a session in the sidebar and select &quot;Share link&quot;</li>
              <li>In <strong className="text-[var(--nim-text)]">Files mode</strong>, right-click a document in the file tree and select &quot;Share Link&quot;</li>
              <li>Links are end-to-end encrypted and you choose the expiration (1, 7, or 30 days)</li>
              <li>View and manage all your shared links under <strong className="text-[var(--nim-text)]">Shared Links</strong> in settings</li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export function SyncPanel() {
  const posthog = usePostHog();
  const isDevelopment = import.meta.env.DEV;

  // Sync config from Jotai atom
  const [config, setConfig] = useAtom(syncConfigAtom);
  const [, updateConfig] = useAtom(setSyncConfigAtom);
  const releaseChannel = useAtomValue(releaseChannelAtom);
  const isAlpha = releaseChannel === 'alpha';

  // Collaboration alpha feature -- enables the Team and Trackers settings panels.
  const [advancedSettings] = useAtom(advancedSettingsAtom);
  const [, updateAdvancedSettings] = useAtom(setAdvancedSettingsAtom);
  const collaborationEnabled = advancedSettings.alphaFeatures.collaboration ?? false;

  // Compute effective server URL early so it can be used throughout
  // Only honor config.environment in dev builds - production always uses production sync
  // Default to production even in dev builds (user must explicitly switch to development)
  const PRODUCTION_SYNC_URL = 'wss://sync.nimbalyst.com';
  const DEVELOPMENT_SYNC_URL = 'ws://localhost:8790';
  const effectiveEnvironment = isDevelopment ? config.environment : undefined;
  const currentEnvironment = effectiveEnvironment || 'production';
  const effectiveServerUrl = currentEnvironment === 'development' ? DEVELOPMENT_SYNC_URL : PRODUCTION_SYNC_URL;

  const [projects, setProjects] = useState<Project[]>([]);
  const [showQRModal, setShowQRModal] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [connectedDevices, setConnectedDevices] = useState<DeviceInfo[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [stytchAuth, setStytchAuth] = useState<StytchAuthState>({
    isAuthenticated: false,
    user: null,
  });

  // Multi-account state
  interface AccountInfo {
    personalOrgId: string;
    personalUserId: string | null;
    email: string | null;
    isPrimary: boolean;
  }
  const [allAccounts, setAllAccounts] = useState<AccountInfo[]>([]);

  // Account deletion state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Auth UI state
  const [showAuthForm, setShowAuthForm] = useState(false);
  const [email, setEmail] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [magicLinkSent, setMagicLinkSent] = useState(false);

  const wasAuthenticatedRef = useRef(stytchAuth.isAuthenticated);
  useEffect(() => { wasAuthenticatedRef.current = stytchAuth.isAuthenticated; }, [stytchAuth.isAuthenticated]);

  const isStytchAvailable = !!window.electronAPI?.stytch;

  const enabledProjects = config.enabledProjects ?? [];
  const enabledProjectCount = enabledProjects.length;

  // Derive whether sync is effectively active (has projects selected)
  const isSyncActive = config.enabled && enabledProjectCount > 0;

  // Load accounts list
  const loadAccounts = async () => {
    if (!window.electronAPI?.stytch?.getAccounts) return;
    try {
      const accts = await window.electronAPI.stytch.getAccounts();
      setAllAccounts(accts || []);
    } catch (err) {
      console.warn('Failed to load accounts:', err);
    }
  };

  // Load Stytch auth state on mount and validate session server-side
  useEffect(() => {
    async function loadStytchAuth() {
      if (!window.electronAPI?.stytch) return;
      try {
        const state = await window.electronAPI.stytch.getAuthState();
        setStytchAuth({
          isAuthenticated: state.isAuthenticated,
          user: state.user,
        });

        // Validate session is actually alive server-side.
        // If dead, this triggers signOut which broadcasts auth state change
        // and the onAuthStateChange listener below will update the UI.
        if (state.isAuthenticated) {
          window.electronAPI.stytch.refreshSession();
        }
      } catch (error) {
        console.error('Failed to load Stytch auth state:', error);
      }
    }

    loadStytchAuth();
    loadAccounts();

    if (!window.electronAPI?.stytch) return;

    // Subscribe to auth state changes in main process (registers the IPC broadcast listener)
    window.electronAPI.stytch.subscribeAuthState();

    // Listen for auth state change IPC events
    const unsubscribe = window.electronAPI.stytch.onAuthStateChange((state: StytchAuthState) => {
      // Track sign-in completion (transition from not authenticated to authenticated)
      if (!wasAuthenticatedRef.current && state.isAuthenticated && posthog) {
        posthog.capture('sync_sign_in_completed');
      }

      setStytchAuth({
        isAuthenticated: state.isAuthenticated,
        user: state.user,
      });

      // Refresh accounts list on auth state change
      loadAccounts();

      // Set email in PostHog for identity linking when user logs in via Stytch
      const userEmail = state.user?.emails?.[0]?.email;
      if (state.isAuthenticated && userEmail && posthog) {
        posthog.people.set({ email: userEmail });
      }
    });

    return unsubscribe;
  }, [posthog]);

  // Load projects from workspace store
  useEffect(() => {
    async function loadProjects() {
      try {
        const workspaces = await window.electronAPI.invoke('get-recent-workspaces');
        setProjects(workspaces.map((ws: any) => ({
          path: ws.path,
          name: ws.name,
        })));
      } catch (error) {
        console.error('Failed to load workspaces:', error);
      }
    }
    loadProjects();
  }, []);

  // Load connected devices when sync is enabled
  const loadDevices = async () => {
    if (!config.enabled || !effectiveServerUrl) {
      setConnectedDevices([]);
      return;
    }

    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const result = await window.electronAPI.invoke('sync:get-devices');
      if (result.success) {
        setConnectedDevices(result.devices || []);
      } else {
        setDevicesError(result.error || 'Failed to load devices');
        setConnectedDevices([]);
      }
    } catch (error) {
      console.error('Failed to load devices:', error);
      setDevicesError('Failed to load devices');
      setConnectedDevices([]);
    } finally {
      setDevicesLoading(false);
    }
  };

  useEffect(() => {
    if (config.enabled && effectiveServerUrl) {
      loadDevices();
      const interval = setInterval(loadDevices, 30000);
      return () => clearInterval(interval);
    } else {
      setConnectedDevices([]);
      return undefined;
    }
  }, [config.enabled, effectiveServerUrl]);

  const handleAddProject = async (projectPath: string) => {
    const currentEnabled = config.enabledProjects ?? [];
    if (currentEnabled.includes(projectPath)) return;

    const updated = [...currentEnabled, projectPath];
    setConfig({ ...config, enabledProjects: updated, enabled: true });

    if (!config.enabled) {
      posthog?.capture('sync_enabled', { projectCount: updated.length });
    }

    try {
      await window.electronAPI.invoke('sync:toggle-project', projectPath, true);
    } catch (error) {
      console.error('[SyncPanel] Failed to add project sync:', error);
    }

    setShowAddProject(false);
  };

  const handleRemoveProject = async (projectPath: string) => {
    const currentEnabled = config.enabledProjects ?? [];
    const updated = currentEnabled.filter(p => p !== projectPath);
    const docSyncUpdated = (config.docSyncEnabledProjects ?? []).filter(p => p !== projectPath);

    const shouldEnable = updated.length > 0;
    setConfig({ ...config, enabledProjects: updated, docSyncEnabledProjects: docSyncUpdated, enabled: shouldEnable });

    if (!shouldEnable && config.enabled) {
      posthog?.capture('sync_disabled', { projectCount: 0 });
    }

    try {
      await window.electronAPI.invoke('sync:toggle-project', projectPath, false);
    } catch (error) {
      console.error('[SyncPanel] Failed to remove project sync:', error);
    }
  };

  const handleDocSyncToggle = async (projectPath: string, enabled: boolean) => {
    const current = config.docSyncEnabledProjects ?? [];
    const updated = enabled
      ? [...current, projectPath]
      : current.filter(p => p !== projectPath);

    const newConfig = { ...config, docSyncEnabledProjects: updated };
    setConfig(newConfig);

    try {
      await window.electronAPI.invoke('sync:set-config', newConfig);
    } catch (error) {
      console.error('[SyncPanel] Failed to toggle doc sync:', error);
    }
  };

  const handleFieldChange = (field: keyof SyncConfig, value: string | boolean | number) => {
    updateConfig({ [field]: value });
  };

  // Environment switch handler (dev only)
  // Saves config immediately so auth endpoints use the correct server
  const handleEnvironmentSwitch = async (newEnv: 'development' | 'production') => {
    // Build new config with environment - serverUrl is derived by the backend from environment
    // Don't set serverUrl explicitly to avoid stale persisted values
    const newConfig = { ...config, environment: newEnv, serverUrl: '' };

    // Update atom (will trigger debounced persistence, but we also save immediately below)
    updateConfig({ environment: newEnv, serverUrl: '' });

    // Save immediately so main process has correct config for auth
    // (This bypasses debounce because auth needs the config right away)
    try {
      await window.electronAPI.invoke('sync:set-config', newConfig);
    } catch (err) {
      console.error('Failed to save sync config:', err);
      setAuthError(`Failed to save config: ${err}`);
      return;
    }

    // Switch Stytch environment (this will sign out the user)
    if (!window.electronAPI?.stytch?.switchEnvironment) {
      console.error('Stytch API not available - cannot switch environment');
      setAuthError('Stytch API not available. Try restarting the app.');
      return;
    }

    try {
      await window.electronAPI.stytch.switchEnvironment(newEnv);
    } catch (err) {
      console.error('Failed to switch Stytch environment:', err);
      setAuthError(`Failed to switch environment: ${err}`);
    }
  };

  // Auth handlers
  const handleGoogleSignIn = async () => {
    if (!window.electronAPI?.stytch) return;
    setAuthLoading(true);
    setAuthError(null);
    posthog?.capture('sync_sign_in_started', { method: 'google' });
    try {
      const result = await window.electronAPI.stytch.signInWithGoogle();
      if (!result.success && result.error) {
        setAuthError(result.error);
      } else {
        setShowAuthForm(false);
      }
    } catch (err) {
      setAuthError(String(err));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSendMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.electronAPI?.stytch) return;
    if (!email) {
      setAuthError('Email is required');
      return;
    }

    setAuthLoading(true);
    setAuthError(null);
    posthog?.capture('sync_sign_in_started', { method: 'magic_link' });
    try {
      const result = await window.electronAPI.stytch.sendMagicLink(email);

      if (!result.success && result.error) {
        setAuthError(result.error);
      } else {
        setMagicLinkSent(true);
      }
    } catch (err) {
      setAuthError(String(err));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    if (!window.electronAPI?.stytch) return;
    posthog?.capture('sync_sign_out');
    try {
      await window.electronAPI.stytch.signOut();
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  const handleAddAccount = async () => {
    if (!window.electronAPI?.stytch?.addAccount) return;
    posthog?.capture('sync_add_account');
    try {
      await window.electronAPI.stytch.addAccount();
    } catch (err) {
      console.error('Add account error:', err);
    }
  };

  const handleRemoveAccount = async (personalOrgId: string) => {
    if (!window.electronAPI?.stytch?.removeAccount) return;
    posthog?.capture('sync_remove_account');
    try {
      await window.electronAPI.stytch.removeAccount(personalOrgId);
      loadAccounts();
    } catch (err) {
      console.error('Remove account error:', err);
    }
  };

  const handleDeleteAccount = async () => {
    if (!window.electronAPI?.stytch) return;
    setDeleteLoading(true);
    setDeleteError(null);
    posthog?.capture('account_deletion_confirmed');
    try {
      const result = await window.electronAPI.stytch.deleteAccount();
      if (result.success) {
        posthog?.capture('account_deletion_completed');
        setShowDeleteConfirm(false);
        setDeleteConfirmText('');
      } else {
        posthog?.capture('account_deletion_failed', { error: result.error });
        setDeleteError(result.error || 'Failed to delete account');
      }
    } catch (err) {
      posthog?.capture('account_deletion_failed', { error: String(err) });
      setDeleteError(String(err));
    } finally {
      setDeleteLoading(false);
    }
  };

  // Only show projects that are enabled for sync
  const syncedProjects = projects.filter(p => enabledProjects.includes(p.path));
  // Projects available to add (not yet synced)
  const availableProjects = projects.filter(p => !enabledProjects.includes(p.path));

  return (
    <div className="provider-panel flex flex-col">
      {/* Header */}
      <div className="provider-panel-header mb-5 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)]">Account & Sync</h3>
        <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
          Access and control Nimbalyst from the mobile app.
          Share sessions and documents via encrypted share links.
          All data is end-to-end encrypted.
        </p>
      </div>

      {/* Team Collaboration (alpha) */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <div className="flex items-center gap-2 mb-2">
          <h4 className="provider-panel-section-title text-base font-semibold text-[var(--nim-text)] m-0">Team Collaboration</h4>
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </div>
        <SettingsToggle
          variant="enable"
          name="Enable team collaboration"
          description="Adds shared trackers and team management. Reveals Team and Trackers settings panels."
          checked={collaborationEnabled}
          onChange={(checked) => {
            updateAdvancedSettings({
              alphaFeatures: {
                ...advancedSettings.alphaFeatures,
                collaboration: checked,
              },
            });
            posthog?.capture('alpha_feature_toggled', {
              feature_tag: 'collaboration',
              enabled: checked,
              source: 'sync_panel',
            });
          }}
        />
      </div>

      {/* Environment Toggle - Dev Only */}
      {/*{isDevelopment && (*/}
      {false && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Environment (Dev Only)</h4>
          <div className="flex gap-2">
            <button
              onClick={() => handleEnvironmentSwitch('development')}
              className={`flex-1 px-3 py-2 text-xs border border-nim rounded-md cursor-pointer ${
                currentEnvironment === 'development'
                  ? 'bg-nim-primary text-nim-on-primary font-semibold'
                  : 'bg-nim-secondary text-nim-muted font-normal'
              }`}
            >
              Development
            </button>
            <button
              onClick={() => handleEnvironmentSwitch('production')}
              className={`flex-1 px-3 py-2 text-xs border border-nim rounded-md cursor-pointer ${
                currentEnvironment === 'production'
                  ? 'bg-nim-primary text-nim-on-primary font-semibold'
                  : 'bg-nim-secondary text-nim-muted font-normal'
              }`}
            >
              Production
            </button>
          </div>
          <p className="text-[11px] text-nim-faint mt-1.5 mb-0">
            {currentEnvironment === 'development'
              ? 'Using test Stytch + localhost:8790'
              : 'Using live Stytch + sync.nimbalyst.com'}
          </p>
        </div>
      )}

      {/* Account Section */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        {stytchAuth.isAuthenticated && stytchAuth.user ? (
          <div className="flex flex-col gap-2">
            {/* Show all accounts if multiple, otherwise show primary */}
            {allAccounts.length > 1 ? (
              allAccounts.map((acct) => {
                const isSyncAccount = config.personalOrgId
                  ? acct.personalOrgId === config.personalOrgId
                  : acct.isPrimary;
                return (
                  <div key={acct.personalOrgId} className={`flex items-center gap-3 p-2.5 rounded-lg ${isSyncAccount ? 'bg-nim-primary/8 border border-nim-primary/20' : 'bg-nim-secondary'}`}>
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm shrink-0 ${isSyncAccount ? 'bg-nim-primary' : 'bg-nim-tertiary'}`}>
                      {(acct.email?.[0] || '?').toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-nim text-[13px] truncate">
                        {acct.email || 'Unknown'}
                      </div>
                      <div className="text-[11px] text-nim-faint">
                        {isSyncAccount ? 'Sync account' : (
                          <button
                            onClick={async () => {
                              try {
                                await window.electronAPI.invoke('sync:switch-sync-account', acct.personalOrgId);
                                // Reload config from main process to get updated personalOrgId
                                const freshConfig = await window.electronAPI.invoke('sync:get-config');
                                if (freshConfig) setConfig(freshConfig);
                                loadAccounts();
                              } catch (err) {
                                console.error('Failed to switch sync account:', err);
                              }
                            }}
                            className="text-nim-primary hover:underline cursor-pointer bg-transparent border-none p-0 text-[11px]"
                          >
                            Use for sync
                          </button>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemoveAccount(acct.personalOrgId)}
                      className="px-3 py-1.5 text-xs bg-transparent border border-nim rounded text-nim-muted cursor-pointer hover:bg-nim-hover shrink-0"
                    >
                      Sign Out
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="flex items-center gap-3 p-2.5 bg-nim-secondary rounded-lg">
                <div className="w-9 h-9 rounded-full bg-nim-primary flex items-center justify-center text-nim-on-primary font-semibold text-sm">
                  {(stytchAuth.user.name?.first_name?.[0] || stytchAuth.user.emails[0]?.email[0] || '?').toUpperCase()}
                </div>
                <div className="flex-1">
                  <div className="font-medium text-nim text-[13px]">
                    {stytchAuth.user.name?.first_name
                      ? `${stytchAuth.user.name.first_name} ${stytchAuth.user.name.last_name || ''}`.trim()
                      : stytchAuth.user.emails[0]?.email}
                  </div>
                  <div className="text-[11px] text-nim-faint">
                    {stytchAuth.user.emails[0]?.email}
                  </div>
                </div>
                <button
                  onClick={handleSignOut}
                  className="px-3 py-1.5 text-xs bg-transparent border border-nim rounded text-nim-muted cursor-pointer hover:bg-nim-hover"
                >
                  Sign Out
                </button>
              </div>
            )}
            {/* Add Account button */}
            <button
              onClick={handleAddAccount}
              className="flex items-center gap-2 px-3 py-2 text-xs text-nim-muted bg-transparent border border-dashed border-nim rounded-lg cursor-pointer hover:bg-nim-hover hover:text-nim transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Account
            </button>
          </div>
        ) : showAuthForm ? (
          <div className="p-4 bg-nim-secondary rounded-lg">
            {magicLinkSent ? (
              // Magic link sent confirmation
              <div className="text-center">
                <div className="w-12 h-12 mx-auto mb-3 bg-nim-primary rounded-full flex items-center justify-center">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                    <path d="M22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6z" />
                    <path d="M22 6l-10 7L2 6" />
                  </svg>
                </div>
                <h4 className="m-0 mb-2 text-nim text-[15px]">
                  Check your email
                </h4>
                <p className="m-0 mb-4 text-nim-muted text-[13px]">
                  We sent a sign-in link to <strong>{email}</strong>
                </p>
                <button
                  onClick={() => {
                    setMagicLinkSent(false);
                    setEmail('');
                    setShowAuthForm(false);
                  }}
                  className="px-4 py-2 bg-transparent border border-nim rounded-md text-nim-muted text-[13px] cursor-pointer hover:bg-nim-hover"
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                {/* Google Sign In */}
                <button
                  onClick={handleGoogleSignIn}
                  disabled={authLoading || !isStytchAvailable}
                  className={`w-full px-4 py-2.5 flex items-center justify-center gap-2.5 bg-white border border-nim rounded-md text-[#333] font-medium text-[13px] ${
                    authLoading ? 'cursor-wait opacity-70' : 'cursor-pointer opacity-100'
                  }`}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  Continue with Google
                </button>

                <div className="flex items-center gap-3 my-4 text-nim-faint text-xs">
                  <div className="flex-1 h-px bg-nim" />
                  or
                  <div className="flex-1 h-px bg-nim" />
                </div>

                {/* Email Magic Link Form */}
                <form onSubmit={handleSendMagicLink}>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter your email"
                    disabled={!isStytchAvailable || authLoading}
                    className="w-full px-3 py-2 mb-3 border border-nim rounded-md bg-nim text-nim text-[13px]"
                  />
                  <button
                    type="submit"
                    disabled={authLoading || !isStytchAvailable || !email}
                    className={`w-full px-4 py-2.5 bg-nim-primary border-none rounded-md text-nim-on-primary font-medium text-[13px] ${
                      authLoading ? 'cursor-wait' : 'cursor-pointer'
                    } ${(authLoading || !email) ? 'opacity-70' : 'opacity-100'}`}
                  >
                    {authLoading ? 'Sending...' : 'Send Sign-In Link'}
                  </button>
                </form>

                {authError && (
                  <p className="text-nim-error text-xs mt-2 mb-0">
                    {authError}
                  </p>
                )}

                <button
                  onClick={() => {
                    setShowAuthForm(false);
                    setAuthError(null);
                    setEmail('');
                  }}
                  className="block w-full mt-3 bg-transparent border-none text-nim-faint cursor-pointer text-xs hover:text-nim-muted"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="p-4 bg-nim-secondary rounded-lg text-center">
            <p className="text-[13px] text-nim-muted m-0 mb-3">
              Sign in to sync sessions across all your devices.
            </p>
            <button
              onClick={() => setShowAuthForm(true)}
              disabled={!isStytchAvailable}
              className={`px-5 py-2 bg-nim-primary border-none rounded-md text-nim-on-primary font-medium text-[13px] ${
                isStytchAvailable ? 'cursor-pointer opacity-100' : 'cursor-not-allowed opacity-50'
              }`}
            >
              Sign In or Create Account
            </button>
            {!isStytchAvailable && (
              <p className="text-[11px] text-nim-faint mt-2 mb-0">
                Restart the app to enable authentication.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Sharing Discovery Callout */}
      {stytchAuth.isAuthenticated && (
        <SharingCallout />
      )}


      {/* Mobile App - compact card combining app info + QR pairing */}
      {stytchAuth.isAuthenticated && (
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-[15px] font-semibold mb-3 text-[var(--nim-text)]">Mobile App</h4>
            <div className="flex gap-3.5 p-3.5 bg-nim-secondary rounded-lg">
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shrink-0">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
                  <line x1="12" y1="18" x2="12" y2="18"/>
                </svg>
              </div>
              <div className="flex-1">
                <div className="text-[13px] font-semibold text-nim mb-0.5">
                  Nimbalyst for iOS
                </div>
                <div className="text-[11px] text-nim-faint mb-2">
                  View and respond to AI sessions from your phone
                </div>
                <div className="flex items-center gap-2">
                  <button
                      onClick={() => window.electronAPI.openExternal('https://apps.apple.com/app/id6756393105')}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white rounded text-[11px] font-medium text-gray-900 border-none cursor-pointer hover:bg-gray-100"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                    </svg>
                    App Store
                  </button>
                </div>
              </div>
              {/* Pair Device button - right side of card */}
              <button
                  className="self-center flex flex-col items-center gap-1.5 px-4 py-2.5 bg-nim-primary border-none rounded-lg text-nim-on-primary text-[14px] font-medium cursor-pointer hover:bg-nim-primary-hover disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  onClick={() => {
                    if (enabledProjectCount === 0) {
                      setPairError('Enable at least one project to sync before pairing your device.');
                      return;
                    }
                    setPairError(null);
                    posthog?.capture('sync_qr_pairing_opened');
                    setShowQRModal(true);
                  }}
                  disabled={!effectiveServerUrl}
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="3" height="3" />
                  <rect x="18" y="14" width="3" height="3" />
                  <rect x="14" y="18" width="3" height="3" />
                  <rect x="18" y="18" width="3" height="3" />
                </svg>
                Pair Device
              </button>
            </div>
          </div>
      )}
      {pairError && (
          <p className="mt-2 text-[12px] text-nim-error">
            {pairError}
          </p>
      )}

      {/* Prevent sleep mode selector */}
      {config.enabled && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <div className="flex items-center justify-between">
            <div className="flex-1 mr-3">
              <h4 className="text-[13px] font-medium text-nim m-0">Prevent sleep while syncing</h4>
              <p className="text-[11px] text-nim-muted mt-0.5 mb-0">
                Keeps your computer awake so you can send prompts from your phone. Display can still turn off.
              </p>
            </div>
            <select
              value={config.preventSleepMode ?? (config.preventSleepWhenSyncing ? 'always' : 'off')}
              onChange={(e) => {
                const mode = e.target.value as 'off' | 'always' | 'pluggedIn';
                updateConfig({ preventSleepMode: mode, preventSleepWhenSyncing: undefined });
                window.electronAPI.invoke('sync:set-prevent-sleep', mode);
              }}
              className="bg-nim-secondary border border-nim rounded px-2 py-1 text-[12px] text-nim cursor-pointer shrink-0"
            >
              <option value="off">Off</option>
              <option value="always">Always</option>
              <option value="pluggedIn">When plugged in</option>
            </select>
          </div>
          {(config.preventSleepMode ?? (config.preventSleepWhenSyncing ? 'always' : 'off')) === 'off' && enabledProjectCount > 0 && (
            <div className="flex items-center gap-2 mt-2 p-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-[11px] text-amber-500">
              <svg className="shrink-0" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7 5a1 1 0 112 0v3a1 1 0 11-2 0V5zm1 7a1 1 0 100-2 1 1 0 000 2z" />
              </svg>
              <span>Your computer may sleep and disconnect from sync. Enable sleep prevention to keep the connection alive.</span>
            </div>
          )}
        </div>
      )}

      {/* Synced Projects */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <div className="flex items-center justify-between mb-2">
          <h4 className="provider-panel-section-title text-[15px] font-semibold text-[var(--nim-text)] m-0">Projects accessible on mobile</h4>
          {availableProjects.length > 0 && !showAddProject && (
            <button
              onClick={() => setShowAddProject(true)}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] bg-transparent border border-nim rounded text-nim-muted cursor-pointer hover:bg-nim-hover hover:text-nim"
            >
              <MaterialSymbol icon="add" size={14} />
              Add
            </button>
          )}
        </div>

        {syncedProjects.length === 0 && !showAddProject ? (
          <button
            onClick={() => setShowAddProject(true)}
            disabled={availableProjects.length === 0}
            className={`flex items-center gap-2 px-3 py-2 text-[12px] bg-transparent border border-dashed border-nim rounded-lg w-full ${
              availableProjects.length === 0
                ? 'text-nim-disabled cursor-not-allowed'
                : 'text-nim-muted cursor-pointer hover:bg-nim-hover hover:text-nim'
            }`}
          >
            <MaterialSymbol icon="add" size={16} />
            Add a project to sync
          </button>
        ) : (
          <div className="bg-nim-secondary rounded-lg overflow-hidden">
            {syncedProjects.map((project) => {
              const docSyncEnabled = (config.docSyncEnabledProjects ?? []).includes(project.path);
              return (
                <div key={project.path} className="flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--nim-border)] last:border-b-0 group">
                  <span className="text-[13px] text-nim truncate flex-1">{project.name}</span>
                  {isAlpha && (
                    <label className="flex items-center gap-1 cursor-pointer shrink-0" title="Sync .md files to mobile">
                      <input
                        type="checkbox"
                        checked={docSyncEnabled}
                        onChange={(e) => handleDocSyncToggle(project.path, e.target.checked)}
                        className="w-3 h-3 cursor-pointer accent-[var(--nim-primary)]"
                      />
                      <span className="text-[10px] text-nim-faint">Docs</span>
                    </label>
                  )}
                  <button
                    onClick={() => handleRemoveProject(project.path)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 bg-transparent border-none text-nim-faint cursor-pointer hover:text-nim-muted shrink-0"
                    title="Remove from sync"
                  >
                    <MaterialSymbol icon="close" size={14} />
                  </button>
                </div>
              );
            })}
            {showAddProject && availableProjects.map((project) => (
              <button
                key={project.path}
                onClick={() => handleAddProject(project.path)}
                className="flex items-center gap-2 px-2.5 py-1.5 w-full bg-transparent border-none border-b border-[var(--nim-border)] last:border-b-0 cursor-pointer hover:bg-nim-hover text-left"
              >
                <MaterialSymbol icon="add" size={14} className="text-[var(--nim-primary)] shrink-0" />
                <span className="text-[13px] text-nim-muted truncate">{project.name}</span>
              </button>
            ))}
            {showAddProject && (
              <button
                onClick={() => setShowAddProject(false)}
                className="w-full py-1 text-[11px] text-nim-faint bg-transparent border-none border-t border-[var(--nim-border)] cursor-pointer hover:bg-nim-hover"
              >
                Done
              </button>
            )}
          </div>
        )}

        {/* Idle timeout */}
        <div className="flex items-center justify-between mt-2">
          <span className="text-[11px] text-nim-faint">Push notification delay</span>
          <select
            value={config.idleTimeoutMinutes ?? 5}
            onChange={(e) => handleFieldChange('idleTimeoutMinutes', Number(e.target.value))}
            className="px-1.5 py-0.5 text-[11px] bg-nim-secondary border border-nim rounded text-nim-muted cursor-pointer"
          >
            <option value={1}>1 min</option>
            <option value={2}>2 min</option>
            <option value={5}>5 min</option>
            <option value={10}>10 min</option>
            <option value={15}>15 min</option>
            <option value={30}>30 min</option>
          </select>
        </div>
      </div>

      {/* Paired Devices */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-[15px] font-semibold mb-3 text-[var(--nim-text)]">
          Devices
          <button
            onClick={loadDevices}
            disabled={devicesLoading}
            className={`ml-2 px-1.5 py-0.5 text-[10px] bg-nim-secondary border border-nim rounded text-nim-faint ${
              devicesLoading ? 'cursor-wait' : 'cursor-pointer hover:bg-nim-hover'
            }`}
          >
            Refresh
          </button>
        </h4>
        <div className="mt-2">
          {connectedDevices.length === 0 && !devicesLoading && (
            <div className="text-[12px] text-nim-faint px-2.5 py-2">
              No paired devices. Use &quot;Pair Device&quot; to connect a mobile device.
            </div>
          )}
          {connectedDevices.map((device) => (
            <div
              key={device.deviceId}
              className="flex items-center gap-2.5 px-2.5 py-2 bg-nim-secondary rounded-md mb-1.5 last:mb-0"
            >
              <div className={`w-2 h-2 rounded-full ${device.isOnline ? 'bg-green-500' : 'bg-neutral-500'}`} />
              <div className="flex-1">
                <div className="text-[13px] text-nim">
                  {device.name}
                </div>
                <div className="text-[11px] text-nim-faint">
                  {device.platform}
                  {device.isOnline
                    ? ` - connected ${formatRelativeTime(device.connectedAt)}`
                    : device.lastSeenAt
                      ? ` - last seen ${formatRelativeTime(device.lastSeenAt)}`
                      : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Encryption footer */}
      <div className="provider-panel-section py-4">
        <div className="p-3.5 bg-nim-secondary border border-nim rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--nim-success, #22c55e)" strokeWidth="2" className="shrink-0">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            <span className="text-[13px] font-semibold text-nim-success">
              End-to-End Encryption
            </span>
          </div>
          <p className="m-0 mb-2 text-[12px] text-nim-muted leading-relaxed">
            The QR code securely transfers your encryption key directly between devices.
          </p>
          <ul className="m-0 pl-5 text-[12px] text-nim leading-7">
            <li>Your encryption keys never touch our servers</li>
            <li>Only your devices can decrypt your data</li>
            <li>Sign in with the same account on both devices</li>
          </ul>
        </div>
      </div>

      {/* Delete Account */}
      {stytchAuth.isAuthenticated && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-[15px] font-semibold mb-2 text-[var(--nim-text)]">Danger Zone</h4>
          {!showDeleteConfirm ? (
            <button
              onClick={() => {
                posthog?.capture('account_deletion_started');
                setShowDeleteConfirm(true);
                setDeleteError(null);
              }}
              className="px-4 py-2 text-[13px] bg-transparent border border-red-500/40 rounded-md text-red-500 cursor-pointer hover:bg-red-500/10"
            >
              Delete Account
            </button>
          ) : (
            <div className="p-4 bg-nim-secondary rounded-lg border border-red-500/30">
              <p className="text-[13px] text-nim-muted m-0 mb-3">
                This will permanently delete your account and all synced data, including sessions, shared links, and device pairings. This cannot be undone.
              </p>
              <p className="text-[12px] text-nim-faint m-0 mb-2">
                Type <strong className="text-nim">DELETE</strong> to confirm:
              </p>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="DELETE"
                className="w-full px-3 py-2 mb-3 border border-nim rounded-md bg-nim text-nim text-[13px]"
                disabled={deleteLoading}
                autoFocus
              />
              {deleteError && (
                <p className="text-red-500 text-xs mb-3 m-0">{deleteError}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={handleDeleteAccount}
                  disabled={deleteConfirmText !== 'DELETE' || deleteLoading}
                  className={`px-4 py-2 text-[13px] border-none rounded-md text-white font-medium ${
                    deleteConfirmText === 'DELETE' && !deleteLoading
                      ? 'bg-red-600 cursor-pointer hover:bg-red-700'
                      : 'bg-red-600/40 cursor-not-allowed'
                  }`}
                >
                  {deleteLoading ? 'Deleting...' : 'Delete Account'}
                </button>
                <button
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setDeleteConfirmText('');
                    setDeleteError(null);
                  }}
                  disabled={deleteLoading}
                  className="px-4 py-2 text-[13px] bg-transparent border border-nim rounded-md text-nim-muted cursor-pointer hover:bg-nim-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      <QRPairingModal
        isOpen={showQRModal}
        onClose={() => setShowQRModal(false)}
        serverUrl={effectiveServerUrl}
        preventSleepMode={config.preventSleepMode ?? (config.preventSleepWhenSyncing ? 'always' : 'off')}
        onPreventSleepModeChange={(mode) => {
          updateConfig({ preventSleepMode: mode, preventSleepWhenSyncing: undefined });
          window.electronAPI.invoke('sync:set-prevent-sleep', mode);
        }}
      />
    </div>
  );
}
