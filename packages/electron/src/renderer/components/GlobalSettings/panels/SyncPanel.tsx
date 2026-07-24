import React, { useState, useEffect } from 'react';
import { usePostHog } from 'posthog-js/react';
import { useAtom, useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { QRPairingModal } from './QRPairingModal';
import {
  syncConfigAtom,
  setSyncConfigAtom,
  releaseChannelAtom,
  type SyncConfig,
} from '../../../store/atoms/appSettings';
import { organizationDirectoryAtom, personalAccountsAtom, personalSyncProfilesAtom } from '../../../store/atoms/settingsDomains';
import { stytchAuthAtom } from '../../../store/atoms/stytchAuth';
import { dialogRef, useDialog } from '../../../contexts/DialogContext';
import { DIALOG_IDS } from '../../../dialogs';
import { AccountLoginForm } from '../../Accounts/AccountLoginForm';
import { AccountOrgList } from './AccountOrgList';
import { groupOrganizationsByAccount } from './accountOrganizations';
import { applyProjectSyncChange, persistProjectSyncSelection, selectionState } from './projectSyncSelection';

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

export type PersonalSyncSection = 'accounts' | 'mobile' | 'devices';

export function SyncPanel({ section }: { section: PersonalSyncSection }) {
  const posthog = usePostHog();
  const { confirm } = useDialog();
  const isDevelopment = import.meta.env.DEV;

  // Sync config from Jotai atom
  const [config, setConfig] = useAtom(syncConfigAtom);
  const [, updateConfig] = useAtom(setSyncConfigAtom);
  const releaseChannel = useAtomValue(releaseChannelAtom);
  const isAlpha = releaseChannel === 'alpha';

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
  const [connectedDevices, setConnectedDevices] = useState<DeviceInfo[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [, setAuthError] = useState<string | null>(null);
  const stytchAuth = useAtomValue(stytchAuthAtom) ?? { isAuthenticated: false, user: null };

  // Personal account and profile state stay separate from organization state.
  const [allAccounts, setAllAccounts] = useAtom(personalAccountsAtom);
  const organizationDirectory = useAtomValue(organizationDirectoryAtom);
  const [, setPersonalSyncProfiles] = useAtom(personalSyncProfilesAtom);
  const [refreshingOrganizations, setRefreshingOrganizations] = useState(false);
  // One bucket per signed-in login, in the same order as `allAccounts`, so each
  // account row can render its own organizations inline beneath it.
  const accountOrganizationGroups = React.useMemo(
    () => groupOrganizationsByAccount(allAccounts, organizationDirectory),
    [allAccounts, organizationDirectory],
  );

  // Force a server round-trip, then let the central Stytch listener re-derive
  // the directory atom (components never subscribe to IPC directly).
  const handleRefreshOrganizations = async () => {
    setRefreshingOrganizations(true);
    try {
      await window.electronAPI?.team?.list({ forceRefresh: true });
      window.dispatchEvent(new CustomEvent('nimbalyst:organizations-changed'));
    } catch (error) {
      console.warn('[SyncPanel] Failed to refresh organizations:', error);
    } finally {
      setRefreshingOrganizations(false);
    }
  };
  useEffect(() => {
    setPersonalSyncProfiles(config.personalSyncProfiles ?? {});
  }, [config.personalSyncProfiles, setPersonalSyncProfiles]);

  // Account deletion state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  // Validate the sync account server-side. Centralized Stytch listeners own
  // auth/account state and refresh the atoms used by this panel.
  useEffect(() => {
    if (stytchAuth.isAuthenticated) void window.electronAPI?.stytch?.refreshSession();
  }, [stytchAuth.isAuthenticated]);

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

  // Single write path for the project multi-select: one checkbox and
  // "Select all" go through the same helper and the same one-shot IPC, so a
  // bulk change is one config write and one sync trigger regardless of size.
  const applyProjectSync = async (
    axis: 'mobile' | 'docs',
    projectPaths: string[],
    enabled: boolean,
  ) => {
    const previousConfig = config;
    const { next, syncToggles, docSyncTurnedOn } = applyProjectSyncChange(
      {
        enabledProjects: config.enabledProjects ?? [],
        docSyncEnabledProjects: config.docSyncEnabledProjects ?? [],
      },
      { axis, projectPaths, enabled },
    );
    if (syncToggles.length === 0 && next.docSyncEnabledProjects.length === (config.docSyncEnabledProjects ?? []).length) {
      return;
    }

    const newConfig = { ...config, ...next };
    setConfig(newConfig);

    if (next.enabled && !config.enabled) {
      posthog?.capture('sync_enabled', { projectCount: next.enabledProjects.length });
    } else if (!next.enabled && config.enabled) {
      posthog?.capture('sync_disabled', { projectCount: 0 });
    }

    for (const path of docSyncTurnedOn) {
      updateDocSyncStatus(path, { pending: true, error: null });
    }

    try {
      await persistProjectSyncSelection(window.electronAPI.invoke, next);
    } catch (error) {
      console.error('[SyncPanel] Failed to persist project sync selection:', error);
      setConfig(previousConfig);
      for (const path of docSyncTurnedOn) {
        updateDocSyncStatus(path, {
          pending: false,
          error: `Failed to enable document sync: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    // Projects that lost doc sync have no status to show any more.
    setDocSyncStatus(prev => {
      const remaining = new Set(next.docSyncEnabledProjects);
      const cleaned: typeof prev = {};
      for (const [path, status] of Object.entries(prev)) {
        if (remaining.has(path)) cleaned[path] = status;
      }
      return cleaned;
    });

    // Newly doc-synced projects connect asynchronously; poll so the user sees
    // the toggle take effect (or an error if it never does).
    for (const path of docSyncTurnedOn) {
      void pollDocSyncUntilConnected(path);
    }
  };

  // Per-project doc sync UI feedback (Docs checkbox): pending while the toggle
  // is applied, then live status (connected + file count) or an error.
  interface DocSyncUiStatus {
    pending: boolean;
    error: string | null;
    subscribed?: boolean;
    connected?: boolean;
    fileCount?: number;
  }
  const [docSyncStatus, setDocSyncStatus] = useState<Record<string, DocSyncUiStatus>>({});

  const updateDocSyncStatus = (projectPath: string, updates: Partial<DocSyncUiStatus>) => {
    setDocSyncStatus(prev => {
      const existing: DocSyncUiStatus = prev[projectPath] ?? { pending: false, error: null };
      return { ...prev, [projectPath]: { ...existing, ...updates } };
    });
  };

  const fetchDocSyncStatus = async (projectPath: string): Promise<boolean> => {
    try {
      const result = await window.electronAPI.invoke('sync:get-doc-sync-status', projectPath);
      if (result?.success) {
        updateDocSyncStatus(projectPath, {
          subscribed: result.subscribed,
          connected: result.connected,
          fileCount: result.fileCount,
        });
        return !!result.connected;
      }
    } catch {
      // Non-fatal; leave prior status in place
    }
    return false;
  };

  // Load status for projects that already have doc sync enabled
  useEffect(() => {
    for (const projectPath of config.docSyncEnabledProjects ?? []) {
      fetchDocSyncStatus(projectPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pollDocSyncUntilConnected = async (projectPath: string) => {
    for (const delayMs of [700, 1500, 3000, 5000]) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (await fetchDocSyncStatus(projectPath)) {
        updateDocSyncStatus(projectPath, { pending: false, error: null });
        return;
      }
    }
    updateDocSyncStatus(projectPath, {
      pending: false,
      error: 'Document sync did not connect. Check your connection, then toggle again or restart the app.',
    });
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

  const handleSignOut = async () => {
    if (!window.electronAPI?.stytch) return;
    try {
      let result = await window.electronAPI.stytch.signOut();
      if (result.requiresOfflinePurgeConfirmation) {
        const count = result.pendingDocumentCount ?? 0;
        const approved = await confirm({
          title: 'Delete unsynced offline work?',
          message: `You have unsynced offline edits or attachments in ${count} ${count === 1 ? 'document' : 'documents'}. Signing out will permanently delete that local work.`,
          confirmLabel: 'Sign out and delete',
          cancelLabel: 'Cancel',
          destructive: true,
        });
        if (!approved) return;
        result = await window.electronAPI.stytch.signOut(true);
      }
      if (result.success) posthog?.capture('sync_sign_out');
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  const handleAddAccount = async () => {
    posthog?.capture('sync_add_account');
    dialogRef.current?.open(DIALOG_IDS.ACCOUNT_LOGIN, { mode: 'add-account' });
  };

  const handleRemoveAccount = async (personalOrgId: string) => {
    if (!window.electronAPI?.stytch?.removeAccount) return;
    try {
      let result = await window.electronAPI.stytch.removeAccount(personalOrgId);
      if (result.requiresOfflinePurgeConfirmation) {
        const count = result.pendingDocumentCount ?? 0;
        const approved = await confirm({
          title: 'Remove account and delete unsynced work?',
          message: `This account has unsynced offline edits or attachments in ${count} ${count === 1 ? 'document' : 'documents'}. Removing it will permanently delete that local work.`,
          confirmLabel: 'Remove and delete',
          cancelLabel: 'Cancel',
          destructive: true,
        });
        if (!approved) return;
        result = await window.electronAPI.stytch.removeAccount(personalOrgId, true);
      }
      if (result.success) {
        posthog?.capture('sync_remove_account');
        loadAccounts();
      }
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
      const result = await window.electronAPI.stytch.deleteAccount(config.personalOrgId);
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

  const allProjectPaths = projects.map((project) => project.path);
  const docSyncEnabledProjects = config.docSyncEnabledProjects ?? [];
  const mobileSelection = selectionState(enabledProjects, allProjectPaths);
  const sectionClass = (target: PersonalSyncSection) =>
    section === target ? '' : 'hidden';
  const heading = section === 'accounts'
    ? ['Accounts', 'Manage signed-in personal accounts and choose the one used for personal/mobile sync.']
    : section === 'devices'
      ? ['Devices', 'View devices paired to the active personal sync account.']
      : ['Mobile App', 'Pair your phone and choose which projects it can reach. Personal sync stays zero-knowledge encrypted.'];

  return (
    <div className="personal-sync-panel provider-panel flex flex-col" data-component="SyncPanel" data-testid={`personal-sync-${section}`}>
      {/* Header */}
      <div className="provider-panel-header mb-5 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)]">{heading[0]}</h3>
        <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">{heading[1]}</p>
      </div>

      {section === 'mobile' && config.personalSyncProfiles && Object.keys(config.personalSyncProfiles).length > 0 && (
        <section className="personal-sync-profile-groups mb-4 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3" data-testid="personal-sync-profile-groups">
          <h4 className="m-0 mb-2 text-sm font-semibold">Projects by personal account</h4>
          <div className="flex flex-col gap-2">
            {Object.entries(config.personalSyncProfiles).map(([personalOrgId, profile]) => {
              const account = allAccounts.find((candidate) => candidate.personalOrgId === personalOrgId);
              const isActive = config.personalOrgId === personalOrgId;
              return (
                <article key={personalOrgId} className="personal-sync-profile-group rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] p-2.5" data-testid="personal-sync-profile-group">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium">{account?.email ?? personalOrgId}</span>
                    <span className="text-[var(--nim-text-muted)]">{isActive ? 'Active sync account' : 'Profile retained'}</span>
                  </div>
                  <p className="m-0 mt-1 text-xs text-[var(--nim-text-muted)]">
                    {profile.enabledProjects.length > 0
                      ? profile.enabledProjects.map((projectPath) => projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath).join(', ')
                      : 'No mobile projects selected'}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      )}

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
      <div className={`sync-account-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0 ${sectionClass('accounts')}`}>
        {allAccounts.length > 0 ? (
          <div className="sync-account-list flex flex-col gap-2">
            <div className="sync-account-list-header flex items-center justify-between">
              <h4 className="m-0 text-[13px] font-semibold text-[var(--nim-text)]">Accounts and organizations</h4>
              <button
                type="button"
                onClick={handleRefreshOrganizations}
                disabled={refreshingOrganizations}
                className="rounded border border-[var(--nim-border)] bg-transparent px-2 py-0.5 text-[11px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] disabled:cursor-wait"
                data-testid="sync-organizations-refresh"
              >
                {refreshingOrganizations ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            {allAccounts.map((account, accountIndex) => {
              const isSyncAccount = account.isSyncAccount || account.personalOrgId === config.personalOrgId;

              return (
                <article
                  key={account.personalOrgId}
                  className={`sync-account-row flex flex-col rounded-lg border p-2.5 ${
                    isSyncAccount
                      ? 'border-[var(--nim-primary)] bg-[color-mix(in_srgb,var(--nim-primary)_8%,transparent)]'
                      : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]'
                  }`}
                  data-testid="sync-account-row"
                >
                  <div className="sync-account-identity flex items-center gap-3">
                    <div className={`sync-account-avatar flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                      isSyncAccount
                        ? 'bg-[var(--nim-primary)] text-[var(--nim-on-primary)]'
                        : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)]'
                    }`}>
                      {(account.email?.[0] || '?').toUpperCase()}
                    </div>
                    <div className="sync-account-summary min-w-0 flex-1 select-text">
                      <div className="truncate text-[13px] font-medium text-[var(--nim-text)]">{account.email}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--nim-text-muted)]">
                        {isSyncAccount && (
                          <span className="rounded-full bg-[var(--nim-primary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--nim-on-primary)]">
                            Used for sync
                          </span>
                        )}
                        {account.sessionStatus === 'expired' && (
                          <span className="rounded-full bg-[var(--nim-warning-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--nim-warning)]">
                            Session expired
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="sync-account-actions flex shrink-0 items-center gap-1.5">
                      {account.sessionStatus === 'expired' && (
                        <button
                          type="button"
                          onClick={() => dialogRef.current?.open(DIALOG_IDS.ACCOUNT_LOGIN, { mode: 'reauth', account })}
                          className="rounded border border-[var(--nim-warning)] bg-transparent px-2.5 py-1.5 text-xs text-[var(--nim-warning)] hover:bg-[var(--nim-bg-hover)]"
                        >
                          Reconnect
                        </button>
                      )}
                      {!isSyncAccount && account.sessionStatus !== 'expired' && (
                        <button
                          type="button"
                          onClick={async () => {
                            const result = await window.electronAPI?.stytch?.setSyncAccount(account.personalOrgId);
                            if (!result?.success) return;
                            const freshConfig = await window.electronAPI.invoke('sync:get-config');
                            if (freshConfig) setConfig(freshConfig);
                            await loadAccounts();
                          }}
                          className="rounded border border-[var(--nim-border)] bg-transparent px-2.5 py-1.5 text-xs text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                        >
                          Set as sync account
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRemoveAccount(account.personalOrgId)}
                        className="rounded border border-[var(--nim-border)] bg-transparent px-2.5 py-1.5 text-xs text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)]"
                      >
                        Sign out
                      </button>
                    </div>
                  </div>
                  <AccountOrgList group={accountOrganizationGroups[accountIndex]} />
                </article>
              );
            })}
            <button
              type="button"
              onClick={handleAddAccount}
              className="sync-add-account-button flex items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--nim-border)] bg-transparent px-3 py-2 text-xs text-[var(--nim-text-muted)] transition-colors hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
            >
              <MaterialSymbol icon="person_add" size={16} />
              Add account
            </button>
          </div>
        ) : isStytchAvailable ? (
          <AccountLoginForm mode="first-sign-in" />
        ) : (
          <div className="sync-auth-unavailable rounded-lg bg-[var(--nim-bg-secondary)] p-4 text-center text-xs text-[var(--nim-text-muted)]">
            Restart the app to enable authentication.
          </div>
        )}
      </div>
      {/* Mobile App - compact card combining app info + QR pairing */}
      {stytchAuth.isAuthenticated && (
          <div className={`sync-mobile-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0 ${sectionClass('mobile')}`}>
            <h4 className="provider-panel-section-title text-[15px] font-semibold mb-3 text-[var(--nim-text)]">Pair a device</h4>
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
          <p className={`sync-mobile-section mt-2 text-[12px] text-nim-error ${sectionClass('mobile')}`}>
            {pairError}
          </p>
      )}

      {/* Prevent sleep mode selector */}
      {config.enabled && (
        <div className={`sync-mobile-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0 ${sectionClass('mobile')}`}>
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

      {/* Projects on mobile: one multi-select list, bulk-selectable */}
      <div className={`sync-mobile-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0 ${sectionClass('mobile')}`}>
        <div className="flex items-center justify-between mb-1">
          <h4 className="provider-panel-section-title text-[15px] font-semibold text-[var(--nim-text)] m-0">Projects accessible on mobile</h4>
          {projects.length > 0 && (
            <button
              type="button"
              onClick={() => applyProjectSync('mobile', allProjectPaths, mobileSelection !== 'all')}
              className="rounded border border-nim bg-transparent px-2 py-0.5 text-[11px] text-nim-muted hover:bg-nim-hover hover:text-nim"
              data-testid="sync-project-select-all"
            >
              {mobileSelection === 'all' ? 'Deselect all' : 'Select all'}
            </button>
          )}
        </div>
        <p className="m-0 mb-2 text-[11px] text-nim-faint">
          {enabledProjectCount === 0
            ? 'No projects selected.'
            : `${enabledProjectCount} of ${projects.length} selected.`}
          {isAlpha && ' Docs also syncs each project\u2019s .md files.'}
        </p>

        {projects.length === 0 ? (
          <p className="m-0 rounded-lg border border-dashed border-nim px-3 py-2 text-[12px] text-nim-faint">
            No projects yet. Open a project to make it available on mobile.
          </p>
        ) : (
          <ul className="sync-project-select-list m-0 list-none overflow-hidden rounded-lg bg-nim-secondary p-0" data-testid="sync-project-select-list">
            {projects.map((project) => {
              const mobileEnabled = enabledProjects.includes(project.path);
              const docSyncEnabled = docSyncEnabledProjects.includes(project.path);
              const status = docSyncStatus[project.path];
              return (
                <li key={project.path} className="sync-project-row border-b border-[var(--nim-border)] last:border-b-0" data-testid="sync-project-row" data-project-path={project.path}>
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={mobileEnabled}
                        onChange={(event) => applyProjectSync('mobile', [project.path], event.target.checked)}
                        className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--nim-primary)]"
                        aria-label={`Sync ${project.name} to mobile`}
                      />
                      <span className="truncate text-[13px] text-nim">{project.name}</span>
                    </label>
                    {isAlpha && docSyncEnabled && status && (
                      status.pending ? (
                        <span className="flex shrink-0 items-center gap-1 text-[10px] text-nim-faint" title="Starting document sync">
                          <MaterialSymbol icon="progress_activity" size={12} className="animate-spin" />
                          Syncing...
                        </span>
                      ) : status.error ? (
                        <span className="flex shrink-0 items-center gap-1 text-[10px] text-nim-error" title={status.error}>
                          <MaterialSymbol icon="error" size={12} />
                          Error
                        </span>
                      ) : status.connected ? (
                        <span
                          className="flex shrink-0 items-center gap-1 text-[10px] text-nim-faint"
                          title={`Document sync connected (${status.fileCount ?? 0} files)`}
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-nim-success" />
                          {status.fileCount ?? 0} docs
                        </span>
                      ) : (
                        <span className="flex shrink-0 items-center gap-1 text-[10px] text-nim-warning" title="Document sync is enabled but not connected">
                          <span className="h-1.5 w-1.5 rounded-full bg-nim-warning" />
                          Not connected
                        </span>
                      )
                    )}
                    {isAlpha && (
                      <label className="flex shrink-0 cursor-pointer items-center gap-1" title="Sync .md files to mobile">
                        <input
                          type="checkbox"
                          checked={docSyncEnabled}
                          disabled={status?.pending}
                          onChange={(event) => applyProjectSync('docs', [project.path], event.target.checked)}
                          className="h-3 w-3 cursor-pointer accent-[var(--nim-primary)]"
                          aria-label={`Sync documents in ${project.name}`}
                        />
                        <span className="text-[10px] text-nim-faint">Docs</span>
                      </label>
                    )}
                  </div>
                  {isAlpha && status?.error && (
                    <p className="m-0 px-2.5 pb-1.5 text-[10px] text-nim-error">{status.error}</p>
                  )}
                </li>
              );
            })}
          </ul>
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
      <div className={`sync-devices-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0 ${sectionClass('devices')}`}>
        <h4 className="provider-panel-section-title text-[15px] font-semibold mb-3 text-[var(--nim-text)]">
          Paired devices
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
      <div className={`sync-mobile-section provider-panel-section py-4 ${sectionClass('mobile')}`}>
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
        <div className={`sync-account-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0 ${sectionClass('accounts')}`}>
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
                This will permanently delete the selected personal account{config.personalOrgId ? ` (${config.personalOrgId})` : ''} and its synced data, including sessions, shared links, and device pairings. Team organization data is separate. This cannot be undone.
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
        isOpen={section !== 'accounts' && section !== 'devices' && showQRModal}
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
