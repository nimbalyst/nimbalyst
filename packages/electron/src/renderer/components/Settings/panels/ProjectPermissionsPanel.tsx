/**
 * Project Permissions Panel
 *
 * Manages agent permissions for a workspace including trust status,
 * permission mode, allowed patterns, directories, and URL patterns.
 *
 * Uses Jotai atom family for workspace-scoped state that stays in sync
 * with TrustIndicator and other consumers.
 */

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import {
  workspacePermissionsAtomFamily,
  loadWorkspacePermissions,
  type PermissionMode,
} from '../../../store/atoms/appSettings';

interface ProjectPermissionsPanelProps {
  workspacePath: string;
  workspaceName: string;
}

export const ProjectPermissionsPanel: React.FC<ProjectPermissionsPanelProps> = ({
  workspacePath,
  workspaceName,
}) => {
  const posthog = usePostHog();

  // Get the atom for this workspace
  const permissionsAtom = useMemo(
    () => workspacePermissionsAtomFamily(workspacePath),
    [workspacePath]
  );
  const [permissionsState, setPermissionsState] = useAtom(permissionsAtom);

  // Local UI state
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isAddingDirectory, setIsAddingDirectory] = useState(false);
  const [isAddingUrl, setIsAddingUrl] = useState(false);
  const [newUrlPattern, setNewUrlPattern] = useState('');
  const [newUrlDescription, setNewUrlDescription] = useState('');

  // Extract permissions from state
  const { loading, error: loadError } = permissionsState;
  const permissions = permissionsState;

  // Load permissions on mount or workspace change
  const loadPermissions = useCallback(async () => {
    if (!workspacePath) return;
    setError(null);
    const state = await loadWorkspacePermissions(workspacePath);
    setPermissionsState(state);
    if (state.error) {
      setError(state.error);
    }
  }, [workspacePath, setPermissionsState]);

  useEffect(() => {
    loadPermissions();
  }, [loadPermissions]);

  // Track screen open
  useEffect(() => {
    if (!loading && permissions.permissionMode !== undefined) {
      posthog?.capture('agent_permissions_opened', {
        isTrusted: permissions.permissionMode !== null,
        permissionMode: permissions.permissionMode,
        allowedPatternsCount: permissions.allowedPatterns.length,
        additionalDirectoriesCount: permissions.additionalDirectories.length,
      });
    }
  }, [permissions, loading, posthog]);

  const handleTrustWorkspace = async () => {
    try {
      await window.electronAPI.invoke('permissions:trustWorkspace', workspacePath);
      await loadPermissions();
      setSuccess('Workspace trusted for agent operations');
      posthog?.capture('permission_setting_changed', { action: 'trust_workspace' });
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Failed to trust workspace:', err);
      setError(err instanceof Error ? err.message : 'Failed to trust workspace');
    }
  };

  const handleRevokeWorkspaceTrust = async () => {
    try {
      await window.electronAPI.invoke('permissions:revokeWorkspaceTrust', workspacePath);
      await loadPermissions();
      setSuccess('Workspace trust revoked');
      posthog?.capture('permission_setting_changed', { action: 'revoke_trust' });
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Failed to revoke workspace trust:', err);
      setError(err instanceof Error ? err.message : 'Failed to revoke workspace trust');
    }
  };

  const handlePermissionModeChange = async (mode: PermissionMode) => {
    try {
      await window.electronAPI.invoke('permissions:setPermissionMode', workspacePath, mode);
      await loadPermissions();
      posthog?.capture('permission_setting_changed', { action: 'change_mode', mode });
    } catch (err) {
      console.error('Failed to set permission mode:', err);
      setError(err instanceof Error ? err.message : 'Failed to set permission mode');
    }
  };

  const handleAllowAllUsesClassifierChange = async (enabled: boolean) => {
    try {
      await window.electronAPI.invoke('permissions:setAllowAllUsesClassifier', workspacePath, enabled);
      await loadPermissions();
      posthog?.capture('permission_setting_changed', { action: 'toggle_allow_all_classifier', enabled });
    } catch (err) {
      console.error('Failed to set Allow All classifier option:', err);
      setError(err instanceof Error ? err.message : 'Failed to update classifier option');
    }
  };

  const handleRemovePattern = async (pattern: string, type: 'allowed' | 'denied') => {
    try {
      await window.electronAPI.invoke('permissions:removePattern', workspacePath, pattern);
      await loadPermissions();
      setSuccess(`Pattern removed`);
      posthog?.capture('permission_setting_changed', { action: 'remove_pattern' });
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Failed to remove pattern:', err);
      setError(err instanceof Error ? err.message : 'Failed to remove pattern');
    }
  };

  const handleResetToDefaults = async () => {
    try {
      await window.electronAPI.invoke('permissions:resetToDefaults', workspacePath);
      await loadPermissions();
      setSuccess('Permissions reset to defaults');
      posthog?.capture('permission_setting_changed', { action: 'reset_to_defaults' });
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Failed to reset permissions:', err);
      setError(err instanceof Error ? err.message : 'Failed to reset permissions');
    }
  };

  const handleAddDirectory = async () => {
    setIsAddingDirectory(true);
    try {
      // Use Electron's dialog to select a directory
      const result = await window.electronAPI.invoke('dialog:openDirectory', {
        title: 'Select Additional Directory',
        buttonLabel: 'Add Directory',
      });

      if (result && result.filePaths && result.filePaths.length > 0) {
        const dirPath = result.filePaths[0];
        await window.electronAPI.invoke('permissions:addAdditionalDirectory', workspacePath, dirPath, false);
        await loadPermissions();
        setSuccess('Directory added');
        posthog?.capture('permission_setting_changed', { action: 'add_directory' });
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch (err) {
      console.error('Failed to add directory:', err);
      setError(err instanceof Error ? err.message : 'Failed to add directory');
    } finally {
      setIsAddingDirectory(false);
    }
  };

  const handleRemoveDirectory = async (dirPath: string) => {
    try {
      await window.electronAPI.invoke('permissions:removeAdditionalDirectory', workspacePath, dirPath);
      await loadPermissions();
      setSuccess('Directory removed');
      posthog?.capture('permission_setting_changed', { action: 'remove_directory' });
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Failed to remove directory:', err);
      setError(err instanceof Error ? err.message : 'Failed to remove directory');
    }
  };

  const handleAddUrlPattern = async () => {
    if (!newUrlPattern.trim()) return;

    try {
      await window.electronAPI.invoke(
        'permissions:addAllowedUrlPattern',
        workspacePath,
        newUrlPattern.trim(),
        newUrlDescription.trim()
      );
      await loadPermissions();
      setNewUrlPattern('');
      setNewUrlDescription('');
      setIsAddingUrl(false);
      setSuccess('URL pattern added');
      posthog?.capture('permission_setting_changed', { action: 'add_url_pattern' });
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Failed to add URL pattern:', err);
      setError(err instanceof Error ? err.message : 'Failed to add URL pattern');
    }
  };

  const handleRemoveUrlPattern = async (pattern: string) => {
    try {
      await window.electronAPI.invoke('permissions:removeAllowedUrlPattern', workspacePath, pattern);
      await loadPermissions();
      setSuccess('URL pattern removed');
      posthog?.capture('permission_setting_changed', { action: 'remove_url_pattern' });
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Failed to remove URL pattern:', err);
      setError(err instanceof Error ? err.message : 'Failed to remove URL pattern');
    }
  };

  const handleAllowAllDomains = async () => {
    try {
      await window.electronAPI.invoke('permissions:allowAllUrls', workspacePath);
      await loadPermissions();
      setSuccess('All domains are now allowed');
      posthog?.capture('permission_setting_changed', { action: 'allow_all_domains' });
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Failed to allow all domains:', err);
      setError(err instanceof Error ? err.message : 'Failed to allow all domains');
    }
  };

  const handleRevokeAllDomains = async () => {
    try {
      await window.electronAPI.invoke('permissions:revokeAllUrlsPermission', workspacePath);
      await loadPermissions();
      setSuccess('All domains permission revoked');
      posthog?.capture('permission_setting_changed', { action: 'revoke_all_domains' });
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Failed to revoke all domains permission:', err);
      setError(err instanceof Error ? err.message : 'Failed to revoke all domains permission');
    }
  };

  // Check if "all domains" wildcard is enabled (pattern is '*' which maps to 'WebFetch')
  const isAllDomainsAllowed = permissions?.allowedUrlPatterns?.some(p => p.pattern === 'WebFetch') ?? false;

  if (!workspacePath) {
    return (
      <div className="settings-panel-content flex flex-col p-6">
        <div className="settings-panel-empty text-center py-12 text-[var(--nim-text-muted)]">
          <p>Open a workspace to configure agent permissions.</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="settings-panel-content flex flex-col p-6">
        <div className="settings-panel-loading text-center py-12 text-[var(--nim-text-muted)]">Loading permissions...</div>
      </div>
    );
  }

  return (
    <div className="settings-panel-content flex flex-col p-6">
      <div className="settings-panel-header mb-6">
        <h2 className="text-xl font-semibold text-[var(--nim-text)] mb-2">Agent Permissions</h2>
        <p className="text-sm text-[var(--nim-text-muted)] leading-relaxed">
          Manage which commands the AI agent can run in this project.
          Approved patterns are saved to <code className="text-xs bg-[var(--nim-bg-secondary)] px-1 py-0.5 rounded">.claude/settings.local.json</code> and shared with Claude Code CLI.
        </p>
      </div>

      {(error || loadError) && (
        <div className="settings-message error flex items-center gap-2 p-3 mb-4 rounded bg-[var(--nim-error)]/10 text-[var(--nim-error)] text-sm">
          <span className="material-symbols-outlined">error</span>
          <span>{error || loadError}</span>
        </div>
      )}

      {success && (
        <div className="settings-message success flex items-center gap-2 p-3 mb-4 rounded bg-[var(--nim-success)]/10 text-[var(--nim-success)] text-sm">
          <span className="material-symbols-outlined">check_circle</span>
          <span>{success}</span>
        </div>
      )}

      {/* Workspace Trust Section */}
      <div className="permissions-section mb-6">
        <div className="permissions-section-header text-sm font-medium text-[var(--nim-text)] mb-3">
          <span>Workspace Trust</span>
        </div>
        <div className="permissions-trust-card flex items-center justify-between p-4 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
          <div className="permissions-trust-info flex-1">
            <div className="permissions-trust-status flex items-center gap-2 mb-1">
              {permissions?.permissionMode !== null ? (
                <>
                  <span className="material-symbols-outlined permissions-trust-icon trusted text-[var(--nim-success)]">verified</span>
                  <span className="permissions-trust-label text-sm font-medium text-[var(--nim-text)]">This workspace is trusted</span>
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined permissions-trust-icon untrusted text-[var(--nim-warning)]">gpp_maybe</span>
                  <span className="permissions-trust-label text-sm font-medium text-[var(--nim-text)]">This workspace is not trusted</span>
                </>
              )}
            </div>
            <p className="permissions-trust-description text-xs text-[var(--nim-text-muted)]">
              {permissions?.permissionMode !== null
                ? 'The AI agent can run commands in this workspace.'
                : 'Trust this workspace to allow the AI agent to run commands.'}
            </p>
            {permissions?.trustedAt && (
              <p className="permissions-trust-date text-xs text-[var(--nim-text-faint)] mt-1">
                Trusted on {new Date(permissions.trustedAt).toLocaleDateString()}
              </p>
            )}
          </div>
          <div className="permissions-trust-action">
            {permissions?.permissionMode !== null ? (
              <button
                className="btn-secondary px-3 py-1.5 rounded text-xs font-medium border border-[var(--nim-border)] bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                onClick={handleRevokeWorkspaceTrust}
              >
                Revoke Trust
              </button>
            ) : (
              <button
                className="btn-primary px-3 py-1.5 rounded text-xs font-medium bg-[var(--nim-primary)] text-white hover:bg-[var(--nim-primary-hover)] cursor-pointer"
                onClick={handleTrustWorkspace}
              >
                Trust Workspace
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Permission Mode Section - Only show when trusted */}
      {permissions && permissions.permissionMode !== null && (
        <div className="permissions-section mb-6">
          <div className="permissions-section-header text-sm font-medium text-[var(--nim-text)] mb-3">
            <span>Permission Mode</span>
          </div>
          <div className="permissions-mode-options flex flex-col gap-2">
            <label className={`permissions-mode-option flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              permissions.permissionMode === 'ask'
                ? 'border-[var(--nim-primary)] bg-[var(--nim-primary)]/5'
                : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] hover:bg-[var(--nim-bg-hover)]'
            }`}>
              <input
                type="radio"
                name="permissionMode"
                value="ask"
                checked={permissions.permissionMode === 'ask'}
                onChange={() => handlePermissionModeChange('ask')}
                className="sr-only"
              />
              <div className="permissions-mode-option-content flex items-start gap-3">
                <span className="material-symbols-outlined text-[var(--nim-text-muted)]">verified_user</span>
                <div className="permissions-mode-option-text flex flex-col gap-0.5">
                  <span className="permissions-mode-option-title text-sm font-medium text-[var(--nim-text)]">Ask</span>
                  <span className="permissions-mode-option-description text-xs text-[var(--nim-text-muted)]">
                    Agent asks before running commands. Approvals saved to .claude/settings.local.json.
                  </span>
                </div>
              </div>
            </label>
            <label className={`permissions-mode-option flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              permissions.permissionMode === 'allow-all'
                ? 'border-[var(--nim-primary)] bg-[var(--nim-primary)]/5'
                : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] hover:bg-[var(--nim-bg-hover)]'
            }`}>
              <input
                type="radio"
                name="permissionMode"
                value="allow-all"
                checked={permissions.permissionMode === 'allow-all'}
                onChange={() => handlePermissionModeChange('allow-all')}
                className="sr-only"
              />
              <div className="permissions-mode-option-content flex items-start gap-3">
                <span className="material-symbols-outlined text-[var(--nim-text-muted)]">check_circle</span>
                <div className="permissions-mode-option-text flex flex-col gap-0.5">
                  <span className="permissions-mode-option-title text-sm font-medium text-[var(--nim-text)]">Allow Edits</span>
                  <span className="permissions-mode-option-description text-xs text-[var(--nim-text-muted)]">
                    File operations auto-approved. Bash and web requests follow Claude Code settings.
                  </span>
                </div>
              </div>
            </label>
            <label className={`permissions-mode-option flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
              permissions.permissionMode === 'bypass-all'
                ? 'border-[var(--nim-primary)] bg-[var(--nim-primary)]/5'
                : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] hover:bg-[var(--nim-bg-hover)]'
            }`}>
              <input
                type="radio"
                name="permissionMode"
                value="bypass-all"
                checked={permissions.permissionMode === 'bypass-all'}
                onChange={() => handlePermissionModeChange('bypass-all')}
                className="sr-only"
              />
              <div className="permissions-mode-option-content flex items-start gap-3">
                <span className="material-symbols-outlined text-[var(--nim-text-muted)]">check_circle</span>
                <div className="permissions-mode-option-text flex flex-col gap-0.5">
                  <span className="permissions-mode-option-title text-sm font-medium text-[var(--nim-text)]">Allow All</span>
                  <span className="permissions-mode-option-description text-xs text-[var(--nim-text-muted)]">
                    All operations auto-approved without any prompts.
                  </span>
                </div>
              </div>
            </label>

            {permissions.permissionMode === 'bypass-all' && (
              <label className="permissions-allow-all-classifier flex items-start gap-2 mt-1 ml-9 cursor-pointer">
                <input
                  type="checkbox"
                  checked={permissions.allowAllUsesClassifier}
                  onChange={(e) => handleAllowAllUsesClassifierChange(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-xs text-[var(--nim-text-muted)]">
                  Run an AI safety classifier on risky operations (Claude Code). When on, deploys and
                  other destructive commands prompt for confirmation instead of running silently.
                </span>
              </label>
            )}
          </div>
        </div>
      )}

      {/* Additional Directories Section - Only show when trusted */}
      {permissions?.permissionMode !== null && (
        <div className="permissions-section mb-6">
          <div className="permissions-section-header flex items-center gap-2 text-sm font-medium text-[var(--nim-text)] mb-2">
            <span>Additional Directories</span>
            <span className="permissions-section-count text-xs px-1.5 py-0.5 rounded bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">{permissions?.additionalDirectories.length || 0}</span>
          </div>
          <p className="permissions-section-description text-xs text-[var(--nim-text-muted)] mb-3">
            Allow the agent to access directories outside this project.
          </p>
          {permissions?.additionalDirectories.length === 0 ? (
            <div className="permissions-empty-state text-xs text-[var(--nim-text-faint)] py-4 px-3 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)]">
              No additional directories. The agent can only access files within this project.
            </div>
          ) : (
            <div className="permissions-directory-list flex flex-col gap-2 mb-3">
              {permissions?.additionalDirectories.map((dir) => (
                <div key={dir.path} className="permissions-directory-item flex items-center justify-between p-2 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)]">
                  <div className="permissions-directory-path flex items-center gap-2 min-w-0 flex-1">
                    <span className="material-symbols-outlined text-[var(--nim-text-muted)] text-base">folder</span>
                    <span className="permissions-directory-path-text text-xs text-[var(--nim-text)] truncate" title={dir.path}>{dir.path}</span>
                  </div>
                  <button
                    className="permissions-directory-remove w-6 h-6 flex items-center justify-center rounded text-[var(--nim-text-muted)] hover:text-[var(--nim-error)] hover:bg-[var(--nim-bg-hover)] cursor-pointer bg-transparent border-none"
                    onClick={() => handleRemoveDirectory(dir.path)}
                    title="Remove directory"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                      <path d="M2 4h12M6 4V2.5A1.5 1.5 0 017.5 1h1A1.5 1.5 0 0110 2.5V4M5 7v5M8 7v5M11 7v5M3 4v9.5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5V4"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            className="btn-secondary permissions-add-directory-btn px-3 py-1.5 rounded text-xs font-medium border border-[var(--nim-border)] bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] cursor-pointer flex items-center gap-1 disabled:opacity-50"
            onClick={handleAddDirectory}
            disabled={isAddingDirectory}
          >
            <span className="material-symbols-outlined text-base">add</span>
            Add Directory
          </button>
        </div>
      )}

      {/* Allowed URL Patterns Section - Only show when trusted */}
      {permissions?.permissionMode !== null && (
        <div className="permissions-section mb-6">
          <div className="permissions-section-header flex items-center gap-2 text-sm font-medium text-[var(--nim-text)] mb-2">
            <span>Allowed URL Patterns</span>
            <span className="permissions-section-count text-xs px-1.5 py-0.5 rounded bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">{permissions?.allowedUrlPatterns?.length || 0}</span>
          </div>
          <p className="permissions-section-description text-xs text-[var(--nim-text-muted)] mb-3">
            Allow the agent to fetch or curl specific domains.
            Use wildcards like <code className="bg-[var(--nim-bg-tertiary)] px-1 py-0.5 rounded">*.github.com</code> to allow all subdomains.
          </p>

          {/* All Domains Allowed Card */}
          {isAllDomainsAllowed ? (
            <div className="permissions-all-domains-card flex items-center justify-between p-3 rounded-lg border border-[var(--nim-primary)]/30 bg-[var(--nim-primary)]/5">
              <div className="permissions-all-domains-info flex items-center gap-3">
                <span className="material-symbols-outlined permissions-all-domains-icon text-[var(--nim-primary)]">public</span>
                <div className="permissions-all-domains-text flex flex-col">
                  <span className="permissions-all-domains-title text-sm font-medium text-[var(--nim-text)]">All domains allowed</span>
                  <span className="permissions-all-domains-description text-xs text-[var(--nim-text-muted)]">
                    The agent can fetch from any URL without asking.
                  </span>
                </div>
              </div>
              <button
                className="btn-secondary px-3 py-1.5 rounded text-xs font-medium border border-[var(--nim-border)] bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                onClick={handleRevokeAllDomains}
              >
                Revoke
              </button>
            </div>
          ) : (
            <>
              {(permissions?.allowedUrlPatterns?.length || 0) === 0 && !isAddingUrl ? (
                <div className="permissions-empty-state text-xs text-[var(--nim-text-faint)] py-4 px-3 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] mb-3">
                  No URL patterns allowed yet. The agent will ask before making web requests.
                </div>
              ) : (
                <div className="permissions-url-list flex flex-col gap-2 mb-3">
                  {permissions?.allowedUrlPatterns?.map((urlPattern) => (
                    <div key={urlPattern.pattern} className="permissions-url-item flex items-center justify-between p-2 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)]">
                      <div className="permissions-url-info flex flex-col min-w-0 flex-1">
                        <span className="permissions-url-pattern text-xs font-medium text-[var(--nim-text)] font-mono">{urlPattern.pattern}</span>
                        {urlPattern.description && (
                          <span className="permissions-url-description text-xs text-[var(--nim-text-muted)]">{urlPattern.description}</span>
                        )}
                      </div>
                      <button
                        className="permissions-url-remove w-6 h-6 flex items-center justify-center rounded text-[var(--nim-text-muted)] hover:text-[var(--nim-error)] hover:bg-[var(--nim-bg-hover)] cursor-pointer bg-transparent border-none"
                        onClick={() => handleRemoveUrlPattern(urlPattern.pattern)}
                        title="Remove URL pattern"
                      >
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                          <path d="M2 4h12M6 4V2.5A1.5 1.5 0 017.5 1h1A1.5 1.5 0 0110 2.5V4M5 7v5M8 7v5M11 7v5M3 4v9.5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5V4"/>
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {isAddingUrl ? (
                <div className="permissions-add-url-form flex flex-col gap-2 p-3 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)]">
                  <input
                    type="text"
                    className="permissions-url-input px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] text-sm placeholder:text-[var(--nim-text-faint)]"
                    placeholder="URL pattern (e.g., *.github.com)"
                    value={newUrlPattern}
                    onChange={(e) => setNewUrlPattern(e.target.value)}
                    autoFocus
                  />
                  <input
                    type="text"
                    className="permissions-url-input px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] text-sm placeholder:text-[var(--nim-text-faint)]"
                    placeholder="Description (optional)"
                    value={newUrlDescription}
                    onChange={(e) => setNewUrlDescription(e.target.value)}
                  />
                  <div className="permissions-add-url-actions flex items-center gap-2 justify-end mt-1">
                    <button
                      className="btn-secondary px-3 py-1.5 rounded text-xs font-medium border border-[var(--nim-border)] bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                      onClick={() => {
                        setIsAddingUrl(false);
                        setNewUrlPattern('');
                        setNewUrlDescription('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn-primary px-3 py-1.5 rounded text-xs font-medium bg-[var(--nim-primary)] text-white hover:bg-[var(--nim-primary-hover)] cursor-pointer disabled:opacity-50"
                      onClick={handleAddUrlPattern}
                      disabled={!newUrlPattern.trim()}
                    >
                      Add
                    </button>
                  </div>
                </div>
              ) : (
                <div className="permissions-url-actions flex items-center gap-2">
                  <button
                    className="btn-secondary permissions-add-url-btn px-3 py-1.5 rounded text-xs font-medium border border-[var(--nim-border)] bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] cursor-pointer flex items-center gap-1"
                    onClick={() => setIsAddingUrl(true)}
                  >
                    <span className="material-symbols-outlined text-base">add</span>
                    Add URL Pattern
                  </button>
                  <button
                    className="btn-secondary permissions-allow-all-btn px-3 py-1.5 rounded text-xs font-medium border border-[var(--nim-border)] bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] cursor-pointer flex items-center gap-1"
                    onClick={handleAllowAllDomains}
                  >
                    <span className="material-symbols-outlined text-base">public</span>
                    Allow All Domains
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Allowed Patterns Section - Only show when trusted */}
      {permissions?.permissionMode !== null && (
        <div className="permissions-section mb-6">
          <div className="permissions-section-header flex items-center gap-2 text-sm font-medium text-[var(--nim-text)] mb-2">
            <span>Allowed Patterns</span>
            <span className="permissions-section-count text-xs px-1.5 py-0.5 rounded bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">{permissions?.allowedPatterns.length || 0}</span>
          </div>
          {permissions?.allowedPatterns.length === 0 ? (
            <div className="permissions-empty-state text-xs text-[var(--nim-text-faint)] py-4 px-3 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)]">
              No patterns allowed yet. When you approve a command, its pattern will appear here.
            </div>
          ) : (
            <div className="permissions-pattern-list flex flex-col gap-2">
              {permissions?.allowedPatterns.map((rule) => (
                <div key={rule.pattern} className="permissions-pattern-item flex items-center justify-between p-2 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)]">
                  <span className="permissions-pattern-name text-xs font-medium text-[var(--nim-text)] font-mono">{rule.displayName}</span>
                  <button
                    className="permissions-pattern-remove w-6 h-6 flex items-center justify-center rounded text-[var(--nim-text-muted)] hover:text-[var(--nim-error)] hover:bg-[var(--nim-bg-hover)] cursor-pointer bg-transparent border-none"
                    onClick={() => handleRemovePattern(rule.pattern, 'allowed')}
                    title="Remove pattern"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                      <path d="M2 4h12M6 4V2.5A1.5 1.5 0 017.5 1h1A1.5 1.5 0 0110 2.5V4M5 7v5M8 7v5M11 7v5M3 4v9.5A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5V4"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}


      {/* Footer */}
      {permissions?.permissionMode !== null && (
        permissions?.allowedPatterns.length ||
        permissions?.allowedUrlPatterns?.length ||
        permissions?.additionalDirectories?.length
      ) ? (
        <div className="permissions-footer pt-4 border-t border-[var(--nim-border)]">
          <button
            className="btn-secondary px-3 py-1.5 rounded text-xs font-medium border border-[var(--nim-border)] bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
            onClick={handleResetToDefaults}
          >
            Reset to Defaults
          </button>
        </div>
      ) : null}
    </div>
  );
};
