import React, { useState, useEffect, useCallback } from 'react';
import { ProviderConfig, Model } from '../../Settings/SettingsView';
import {ClaudeForWindowsInstallation} from "../../../../main/services/CLIManager.ts";
import {usePostHog} from "posthog-js/react";
import { useSetting, useSetSetting } from '../../../hooks/useSetting';
import { SettingsToggle, ToggleSwitch } from '../SettingsToggle';

// Built-in SDK version (injected at build time via electron.vite.config.ts define)
declare const __CLAUDE_AGENT_SDK_VERSION__: string;
const BUNDLED_SDK_VERSION = typeof __CLAUDE_AGENT_SDK_VERSION__ !== 'undefined' ? __CLAUDE_AGENT_SDK_VERSION__ : 'unknown';

/** Props for the sibling Claude Code CLI (subscription) subsection. */
interface ClaudeCliBundle {
  config: ProviderConfig;
  availableModels: Model[];
  loading: boolean;
  onToggle: (enabled: boolean) => void;
  onModelVisibilityToggle: (modelId: string, visible: boolean) => void;
  onSetAllVisible: (visible: boolean) => void;
}

interface ClaudeCodePanelProps {
  config: ProviderConfig;
  apiKeys: Record<string, string>;
  availableModels: Model[];
  loading: boolean;
  onToggle: (enabled: boolean) => void;
  onApiKeyChange: (key: string, value: string) => void;
  /** Hidden-set (denylist) handlers for the SDK provider. `visible` = not hidden. */
  onModelVisibilityToggle: (modelId: string, visible: boolean) => void;
  onSetAllVisible: (visible: boolean) => void;
  onTestConnection: () => Promise<void>;
  onConfigChange: (updates: Partial<ProviderConfig>) => void;
  /** The subscription-CLI provider (`claude-code-cli`), toggled independently. */
  cli: ClaudeCliBundle;
  /** Scope this panel is rendered for: 'user' edits global settings, 'project' edits the workspace override. */
  scope?: 'user' | 'project';
  /** Workspace path required when scope is 'project'. */
  workspacePath?: string;
}

type AuthMethod = 'login' | 'api-key';

/**
 * Checkbox list that trims which of a provider's models reach the session picker.
 * A model is checked when it is visible (i.e. NOT in the provider's `hiddenModels`
 * denylist). Unchecking hides it; future new variants appear checked by default.
 */
function AvailableModelsSection({
  models,
  hiddenModels,
  loading,
  onVisibilityToggle,
  onSetAllVisible,
}: {
  models: Model[];
  hiddenModels: string[];
  loading: boolean;
  onVisibilityToggle: (modelId: string, visible: boolean) => void;
  onSetAllVisible: (visible: boolean) => void;
}) {
  return (
    <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
      <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Available models</h4>
      {loading && (
        <div className="models-loading text-sm text-[var(--nim-text-muted)] py-2">Loading models...</div>
      )}
      {!loading && models.length > 0 && (
        <div className="models-section">
          <div className="models-header flex items-center justify-between mb-3">
            <span className="text-sm text-[var(--nim-text-muted)]">Uncheck models to hide them from the picker:</span>
            <div className="models-actions flex gap-2">
              <button
                className="models-action-btn text-xs py-1 px-2 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer transition-all"
                onClick={() => onSetAllVisible(true)}
              >
                Show all
              </button>
              <button
                className="models-action-btn text-xs py-1 px-2 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer transition-all"
                onClick={() => onSetAllVisible(false)}
              >
                Hide all
              </button>
            </div>
          </div>
          <div className="models-grid flex flex-col gap-2">
            {models.map(model => (
              <label key={model.id} className="model-checkbox flex items-center gap-3 py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] cursor-pointer hover:bg-[var(--nim-bg-hover)]">
                <input
                  type="checkbox"
                  checked={!hiddenModels.includes(model.id)}
                  onChange={(e) => onVisibilityToggle(model.id, e.target.checked)}
                  className="w-4 h-4 cursor-pointer accent-[var(--nim-primary)]"
                />
                <span className="text-sm text-[var(--nim-text)]">{model.name}</span>
              </label>
            ))}
          </div>
          <p className="text-[11px] text-[var(--nim-text-faint)] leading-relaxed mt-3">
            Unchecked models are hidden from the session model picker. New models appear automatically.
          </p>
        </div>
      )}
      {!loading && models.length === 0 && (
        <div className="models-loading text-sm text-[var(--nim-text-muted)] py-2">No models available.</div>
      )}
    </div>
  );
}

export function ClaudeCodePanel({
  config,
  apiKeys,
  availableModels,
  loading,
  onToggle,
  onApiKeyChange,
  onModelVisibilityToggle,
  onSetAllVisible,
  onTestConnection,
  onConfigChange,
  cli,
  scope = 'user',
  workspacePath,
}: ClaudeCodePanelProps) {
  const [loginStatus, setLoginStatus] = useState<{
    isLoggedIn: boolean;
    hasOAuthToken: boolean;
    isExpired: boolean;
    expiresAt?: string;
    scopes?: string[];
    email?: string;
    organization?: string;
    subscriptionType?: string;
    tokenSource?: string;
    apiKeySource?: string;
  } | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [selectedAuthMethod, setSelectedAuthMethod] = useState<AuthMethod>(
    config.authMethod as AuthMethod || 'login'
  );
  const [isCheckingClaudeWindowsStatus, setIsCheckingClaudeWindowsStatus] = useState(true);
  const [claudeCodeWindowsStatus, setClaudeCodeWindowsStatus] = useState<ClaudeForWindowsInstallation | null>(null);
  const posthog = usePostHog();

  // Environment variables state
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [isLoadingEnv, setIsLoadingEnv] = useState(true);
  const [newEnvKey, setNewEnvKey] = useState('');
  const [newEnvValue, setNewEnvValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  // Usage indicator setting
  const usageIndicatorEnabled = useSetting('ai.showUsageIndicator');
  const setUsageIndicatorEnabled = useSetSetting('ai.showUsageIndicator');

  // Custom Claude executable path. In project scope, `customClaudeCodePath` reflects the
  // workspace override (empty string when no override is set, inheriting the global value);
  // `globalCustomClaudeCodePath` carries the inherited global value to surface as placeholder.
  const [customClaudeCodePath, setCustomClaudeCodePathState] = useState('');
  const [globalCustomClaudeCodePath, setGlobalCustomClaudeCodePath] = useState('');
  const [hasProjectPathOverride, setHasProjectPathOverride] = useState(false);

  // Agent teams toggle (experimental) - stored as env var in ~/.claude/settings.json
  const [agentTeamsEnabled, setAgentTeamsEnabled] = useState(false);

  // Plan tracking toggle - stores plans in nimbalyst-local/plans/ with tracking frontmatter
  const [planTrackingEnabled, setPlanTrackingEnabledState] = useState(true);

  const isWindowsPlatform = process.platform === 'win32';

  // Load environment variables
  const loadEnvVars = useCallback(async () => {
    try {
      setIsLoadingEnv(true);
      const env = await window.electronAPI.claudeCode.getEnv();
      setEnvVars(env);
      // Sync agent teams toggle from env var
      setAgentTeamsEnabled(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1');
    } catch (error) {
      console.error('Failed to load env vars:', error);
    } finally {
      setIsLoadingEnv(false);
    }
  }, []);

  // Save environment variables
  const saveEnvVars = useCallback(async (newEnvVars: Record<string, string>) => {
    try {
      await window.electronAPI.claudeCode.setEnv(newEnvVars);
      setEnvVars(newEnvVars);
      // Keep agent teams toggle in sync
      setAgentTeamsEnabled(newEnvVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1');
    } catch (error) {
      console.error('Failed to save env vars:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      alert(`Failed to save environment variables: ${errorMessage}`);
    }
  }, []);

  // Toggle agent teams env var
  const handleToggleAgentTeams = useCallback(async (enabled: boolean) => {
    const previousEnvVars = envVars;
    setAgentTeamsEnabled(enabled);
    const newEnvVars = { ...envVars };
    if (enabled) {
      newEnvVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    } else {
      delete newEnvVars.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    }
    try {
      await window.electronAPI.claudeCode.setEnv(newEnvVars);
      setEnvVars(newEnvVars);
    } catch (error) {
      console.error('Failed to toggle agent teams:', error);
      setAgentTeamsEnabled(!enabled);
      setEnvVars(previousEnvVars);
    }
  }, [envVars]);

  useEffect(() => {
    // Only check Windows installation status on Windows
    if (isWindowsPlatform) {
      checkClaudeCodeWindowsInstallation();
    } else {
      setIsCheckingClaudeWindowsStatus(false);
    }
    checkLoginStatus();
    loadEnvVars();

    loadSettings();
    // loadSettings depends on scope/workspacePath; rerun when they change so the
    // project-scoped panel reflects the active workspace's override.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadEnvVars, scope, workspacePath]);

  const checkLoginStatus = async () => {
    try {
      const status = await window.electronAPI.invoke('claude-code:check-login');
      setLoginStatus(status);
    } catch (error) {
      console.error('Failed to check login status:', error);
      setLoginStatus({ isLoggedIn: false, hasOAuthToken: false, isExpired: true });
    }
  };

  const checkClaudeCodeWindowsInstallation = async () => {
    try {
      setIsCheckingClaudeWindowsStatus(true);
      console.log('[ClaudeCodePanel] Checking Claude Code Installation Status on Windows...');
      const installation = await window.electronAPI.cliCheckClaudeCodeWindowsInstallation();
      console.log('[ClaudeCodePanel] Claude Code installation status:', JSON.stringify(installation));
      setClaudeCodeWindowsStatus(installation);
      if (installation.isPlatformWindows) {
        posthog.capture('check_claude_code_windows_installation', installation)
      }
    } catch (error) {
      // ignore
    } finally {
      setIsCheckingClaudeWindowsStatus(false);
    }
  };

  function isClaudeCodeWindowsReady(): boolean {
    if (isWindowsPlatform) {
      return Boolean(claudeCodeWindowsStatus?.claudeCodeVersion);
    }
    return true;
  }

  // Load standalone binary setting and check availability
  const loadSettings = async () => {
    try {
      const settings = await window.electronAPI.aiGetSettings();
      const globalPath = settings?.customClaudeCodePath ?? '';
      setGlobalCustomClaudeCodePath(globalPath);
      setPlanTrackingEnabledState(settings?.planTrackingEnabled ?? true);

      if (scope === 'project' && workspacePath) {
        const result = await window.electronAPI.invoke('ai:getProjectSettings', workspacePath);
        const projectPath = result?.success ? result?.overrides?.customClaudeCodePath : undefined;
        if (projectPath !== undefined) {
          setHasProjectPathOverride(true);
          setCustomClaudeCodePathState(projectPath);
        } else {
          setHasProjectPathOverride(false);
          setCustomClaudeCodePathState('');
        }
      } else {
        setHasProjectPathOverride(false);
        setCustomClaudeCodePathState(globalPath);
      }
    } catch (error) {
      console.error('[ClaudeCodePanel] Failed to load settings:', error);
    }
  };

  // Save custom Claude Code path. In project scope this writes to the workspace override;
  // an empty string clears the override (the project then inherits the global value).
  const handleSaveCustomClaudeCodePath = async (newPath: string) => {
    const previousPath = customClaudeCodePath;
    const previousHasOverride = hasProjectPathOverride;
    setCustomClaudeCodePathState(newPath);

    // Guard against a project-scoped edit accidentally falling through to the
    // global save path when workspacePath has not been threaded in yet.
    if (scope === 'project' && !workspacePath) {
      console.error('[ClaudeCodePanel] Project scope requires workspacePath to save customClaudeCodePath; aborting.');
      setCustomClaudeCodePathState(previousPath);
      setHasProjectPathOverride(previousHasOverride);
      return;
    }

    try {
      if (scope === 'project' && workspacePath) {
        const current = await window.electronAPI.invoke('ai:getProjectSettings', workspacePath);
        const baseOverrides = (current?.success && current?.overrides) ? { ...current.overrides } : {};
        if (newPath === '') {
          delete baseOverrides.customClaudeCodePath;
          setHasProjectPathOverride(false);
        } else {
          baseOverrides.customClaudeCodePath = newPath;
          setHasProjectPathOverride(true);
        }
        const saveResult = await window.electronAPI.invoke('ai:saveProjectSettings', workspacePath, baseOverrides);
        if (!saveResult?.success) {
          throw new Error(saveResult?.error || 'Failed to save project override');
        }
      } else {
        // Per-key write via SettingsService -- structurally cannot clobber
        // sibling AI settings the way the old aiSaveSettings blob path could.
        await window.electronAPI.settingsSet('ai.customClaudeCodePath', newPath);
        setGlobalCustomClaudeCodePath(newPath);
      }
    } catch (error) {
      console.error('[ClaudeCodePanel] Failed to save custom Claude Code path:', error);
      setCustomClaudeCodePathState(previousPath);
      setHasProjectPathOverride(previousHasOverride);
    }
  };

  // Save plan tracking setting
  const handleSetPlanTrackingEnabled = async (enabled: boolean) => {
    setPlanTrackingEnabledState(enabled);
    try {
      // Send only the changed field -- ai:saveSettings handles partial updates
      await window.electronAPI.aiSaveSettings({ planTrackingEnabled: enabled });
    } catch (error) {
      console.error('[ClaudeCodePanel] Failed to save plan tracking setting:', error);
      setPlanTrackingEnabledState(!enabled);
    }
  };

  // Browse for custom Claude Code executable
  const handleBrowseCustomClaudeCodePath = async () => {
    try {
      const result = await window.electronAPI.openFileDialog({
        title: 'Select Claude Code Executable',
        buttonLabel: 'Select',
      });
      if (result && !result.canceled && result.filePaths?.length > 0) {
        handleSaveCustomClaudeCodePath(result.filePaths[0]);
      }
    } catch (error) {
      console.error('[ClaudeCodePanel] Failed to open file dialog:', error);
    }
  };

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      const result = await window.electronAPI.invoke('claude-code:login');
      if (result.success) {
        alert(result.message || 'Login initiated! Please complete authentication in the Terminal window (you may have to type /login to complete the process), then click "Refresh Status" to verify.');
      }
    } catch (error: any) {
      alert(`Login failed: ${error.message || 'Unknown error'}`);
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      const result = await window.electronAPI.invoke('claude-code:logout');
      if (result.success) {
        alert(result.message || 'Logout initiated! Please wait for the Terminal window to complete, then click "Refresh Status" to verify.');
      }
    } catch (error: any) {
      alert(`Logout failed: ${error.message || 'Unknown error'}`);
    }
  };

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">Claude Agent</h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Agent mode uses the Claude Code SDK with a few extensions for added functionality in Nimbalyst.
          Has full MCP support with file system access, multi-file operations, and session persistence.
        </p>
      </div>

      <SettingsToggle
        variant="enable"
        name="Enable Claude Agent"
        checked={config.enabled || false}
        onChange={(checked) => {
          // console.log('[ClaudeCodePanel] Toggle changed to:', checked);
          onToggle(checked);
        }}
      />

      {/* Usage Indicator Toggle */}
      <SettingsToggle
        variant="enable"
        name="Show Usage Indicator"
        description="Display API usage limits in the navigation gutter"
        checked={usageIndicatorEnabled}
        onChange={setUsageIndicatorEnabled}
        testId="claude-agent-usage-indicator-toggle"
      />

      {/* Custom Claude Installation */}
      <div className="provider-enable flex flex-col gap-2 py-4 mb-4 border-b border-[var(--nim-border)]">
        <div>
          <span className="provider-enable-label text-sm font-medium text-[var(--nim-text)]">Custom Claude Installation</span>
          <p className="text-xs text-[var(--nim-text-muted)] mt-1">
            {scope === 'project'
              ? 'Override the Claude executable path for this project only. Leave empty to inherit the global setting.'
              : 'Override the default Claude executable path. Use this to point to a custom Claude CLI wrapper (e.g., for corporate SSO authentication).'}
          </p>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <input
            type="text"
            value={customClaudeCodePath}
            onChange={(e) => setCustomClaudeCodePathState(e.target.value)}
            onBlur={(e) => handleSaveCustomClaudeCodePath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleSaveCustomClaudeCodePath((e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).blur();
              }
            }}
            placeholder={scope === 'project' && globalCustomClaudeCodePath
              ? `Inheriting: ${globalCustomClaudeCodePath}`
              : '/usr/local/bin/claude'}
            className="flex-1 py-1.5 px-2 rounded text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] font-mono focus:border-[var(--nim-primary)] outline-none"
          />
          <button
            onClick={handleBrowseCustomClaudeCodePath}
            className="py-1.5 px-3 rounded text-xs font-medium bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] transition-colors whitespace-nowrap"
          >
            Browse
          </button>
        </div>
        <p className="text-[11px] text-[var(--nim-text-faint)] leading-relaxed">
          {scope === 'project'
            ? hasProjectPathOverride
              ? 'Project-specific path active. Clear the field to remove the override and inherit the global value.'
              : globalCustomClaudeCodePath
                ? `Inheriting global path: ${globalCustomClaudeCodePath}. Type a value to override for this project only.`
                : 'No global path set. Type a value to use a custom executable for this project only.'
            : 'Leave empty to use the built-in SDK. Changes take effect on the next agent session.'}
        </p>
      </div>

      {/* Plan Tracking Toggle */}
      <SettingsToggle
        variant="enable"
        name="Plan Tracking"
        description="Save plans to nimbalyst-local/plans/ with tracking frontmatter. When disabled, plans use Claude Code's default behavior."
        checked={planTrackingEnabled}
        onChange={handleSetPlanTrackingEnabled}
      />

      {/* Agent Teams Toggle (Experimental) */}
      <SettingsToggle
        variant="enable"
        name="Agent Teams (Experimental)"
        description="Allow Claude to coordinate multiple agents working together as a team. Uses more tokens but enables parallel work."
        checked={agentTeamsEnabled}
        onChange={handleToggleAgentTeams}
      />

      { isWindowsPlatform && isCheckingClaudeWindowsStatus && (
        <div className="installation-status p-4 rounded-lg bg-[rgba(245,158,11,0.05)] border border-[rgba(245,158,11,0.2)]">
          <div className="installation-status-row flex items-center gap-3 py-1">
            <span className="installation-status-label text-sm font-medium text-[var(--nim-text-muted)]">Checking Claude Code Installation...</span>
          </div>
        </div>
      )}
      { !isCheckingClaudeWindowsStatus && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          { isWindowsPlatform ? (
            <>
              <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Claude Code for Windows Installation</h4>
              <p className="text-xs text-[var(--nim-text-muted)] mt-3 leading-relaxed">
                Nimbalyst requires Claude Code for Windows to be installed to use the Claude Code provider.
              </p>
              { Boolean(claudeCodeWindowsStatus?.claudeCodeVersion) ? (
                <div className="installation-status mt-3 p-4 rounded-lg bg-[rgba(16,185,129,0.05)] border border-[rgba(16,185,129,0.2)]">
                  <div className="installation-status-row flex items-center gap-3 py-1">
                    <span className="installation-status-label text-sm font-medium text-[var(--nim-text-muted)]">Claude Code Version:</span>
                    <span className="installation-status-value text-sm text-[var(--nim-text)]">{claudeCodeWindowsStatus?.claudeCodeVersion}</span>
                  </div>
                </div>
              ): (
                <div className="installation-status mt-3 p-4 rounded-lg bg-[rgba(239,68,68,0.05)] border border-[rgba(239,68,68,0.2)]">
                  <div className="text-xs text-[var(--nim-text-muted)] mt-3 leading-relaxed">
                    <p className="mb-2">Install Claude Code for Windows by following the instructions below:</p>
                    <ol className="list-decimal list-inside space-y-1 mb-4">
                      <li>Install <a href="https://git-scm.com/install/windows" className="text-[var(--nim-link)] hover:underline">Git for Windows</a>. This is a prerequisite for installing Claude Code</li>
                      <li>Install <a href="https://code.claude.com/docs/en/overview#windows" className="text-[var(--nim-link)] hover:underline">Claude Code for Windows</a>.</li>
                      <li>When finished, click the button below to recheck / verify the installation.</li>
                    </ol>
                    <button className="nim-btn-primary" onClick={checkClaudeCodeWindowsInstallation}>Re-verify Claude Code Installation</button>
                  </div>
                </div>
              )}
            </>
          ): (
            <>
              <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Claude Agent SDK</h4>
              <div className="installation-status p-4 rounded-lg bg-[rgba(16,185,129,0.05)] border border-[rgba(16,185,129,0.2)]">
                <div className="installation-status-row flex items-center gap-3 py-1">
                  <span className="installation-status-label text-sm font-medium text-[var(--nim-text-muted)]">Version:</span>
                  <span className="installation-status-value text-sm text-[var(--nim-text)]">{BUNDLED_SDK_VERSION}</span>
                </div>
                <div className="installation-status-row flex items-center gap-3 py-1">
                  <span className="installation-status-label text-sm font-medium text-[var(--nim-text-muted)]">Source:</span>
                  <span className="installation-status-value text-sm text-[var(--nim-text)]">Built-in (bundled with app)</span>
                </div>
                <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mt-3">
                  Nimbalyst includes the Claude Agent SDK. No additional installation required.
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {config.enabled && isClaudeCodeWindowsReady() && (
        <>
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Authentication</h4>
            <div className="api-key-section mt-4">
              {/* Authentication Method Selector */}
              <div className="auth-method-selector mb-4">
                <label className="auth-method-label block text-[13px] font-semibold mb-2 text-[var(--nim-text)]">Authentication Method</label>
                <div className="auth-method-buttons flex gap-2">
                  <button
                    className={`auth-method-button flex-1 py-2.5 px-4 rounded-md text-[13px] font-medium cursor-pointer transition-all border ${
                      selectedAuthMethod === 'login'
                        ? 'border-2 border-[var(--nim-primary)] bg-[rgba(59,130,246,0.1)] text-[var(--nim-primary)]'
                        : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-border-focus)]'
                    }`}
                    onClick={() => {
                      setSelectedAuthMethod('login');
                      onConfigChange({ authMethod: 'login' });
                    }}
                  >
                    Claude Plan (Recommended)
                  </button>
                  <button
                    className={`auth-method-button flex-1 py-2.5 px-4 rounded-md text-[13px] font-medium cursor-pointer transition-all border ${
                      selectedAuthMethod === 'api-key'
                        ? 'border-2 border-[var(--nim-primary)] bg-[rgba(59,130,246,0.1)] text-[var(--nim-primary)]'
                        : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-border-focus)]'
                    }`}
                    onClick={() => {
                      setSelectedAuthMethod('api-key');
                      onConfigChange({ authMethod: 'api-key' });
                    }}
                  >
                    API Key
                  </button>
                </div>
              </div>

              {/* Claude Plan Authentication */}
              {selectedAuthMethod === 'login' && (
                <>
                  {loginStatus?.isLoggedIn ? (
                    <>
                      {/* Logged In State */}
                      <div className="status-box-success mb-4 py-3.5 px-4 rounded-lg text-[13px] flex items-center gap-3 justify-between bg-[rgba(16,185,129,0.08)] border border-[rgba(16,185,129,0.2)]">
                        <div className="flex items-center gap-3 flex-1">
                          <span className="status-box-icon text-xl leading-none shrink-0 text-[var(--nim-success)]">✓</span>
                          <div className="status-box-content flex flex-col gap-1 flex-1">
                            <span className="status-box-title font-semibold text-sm text-[var(--nim-text)]">Authenticated with Claude Plan</span>
                            {loginStatus.email && (
                              <span className="status-box-subtitle text-xs text-[var(--nim-text-muted)]">
                                {loginStatus.email}
                                {loginStatus.organization && ` • ${loginStatus.organization}`}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="status-box-actions flex gap-2 shrink-0">
                          <button className="btn-small py-1.5 px-3 rounded text-xs font-medium cursor-pointer transition-all bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]" onClick={checkLoginStatus}>
                            Refresh
                          </button>
                          <button className="btn-small py-1.5 px-3 rounded text-xs font-medium cursor-pointer transition-all bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]" onClick={handleLogout}>
                            Logout
                          </button>
                        </div>
                      </div>

                      {/* Switch Account Info */}
                      <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-4">
                        Need to use a different Claude account? Logout above and login again.
                      </p>
                    </>
                  ) : (
                    <>
                      {/* Not Logged In State */}
                      <div className="mb-4 p-4 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg">
                        <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-3">
                          Authenticate with your Claude Pro or Team subscription. No API credits needed.
                        </p>
                        <div className="flex gap-2">
                          <button
                            className="nim-btn-primary flex-1"
                            onClick={handleLogin}
                            disabled={isLoggingIn}
                          >
                            {isLoggingIn ? 'Opening Login...' : 'Login with Claude Plan'}
                          </button>
                          <button className="nim-btn-secondary" onClick={checkLoginStatus}>
                            Refresh
                          </button>
                        </div>
                        <p className="text-[11px] leading-relaxed text-[var(--nim-text-faint)] mt-2">
                          Opens Terminal for OAuth authentication. You may have to type /login to complete the process.
                        </p>
                      </div>
                    </>
                  )}
                </>
              )}

              {/* API Key Authentication */}
              {selectedAuthMethod === 'api-key' && (
                <>
                  <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-3">
                    Use an Anthropic API key. Pay-per-use with API credits from your Anthropic account.
                  </p>
                  <div className="api-key-row flex gap-2 items-center">
                    <input
                      type="password"
                      value={apiKeys['claude-code'] || ''}
                      onChange={(e) => onApiKeyChange('claude-code', e.target.value)}
                      onFocus={(e) => e.target.select()}
                      placeholder="sk-ant-..."
                      className="api-key-input flex-1 py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none font-mono focus:border-[var(--nim-primary)]"
                    />
                    {apiKeys['claude-code'] ? (
                      <button
                        className={`test-button inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium whitespace-nowrap cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] ${
                          config.testStatus === 'testing' ? 'opacity-60 cursor-wait' : ''
                        } ${config.testStatus === 'success' ? 'text-[var(--nim-success)] border-[var(--nim-success)]' : ''} ${
                          config.testStatus === 'error' ? 'text-[var(--nim-error)] border-[var(--nim-error)]' : ''
                        }`}
                        onClick={onTestConnection}
                        disabled={config.testStatus === 'testing'}
                      >
                        {config.testStatus === 'testing' ? 'Testing...' :
                         config.testStatus === 'success' ? '✓ Connected' :
                         config.testStatus === 'error' ? '✗ Failed' : 'Test'}
                      </button>
                    ) : null}
                  </div>
                  {config.testMessage && config.testStatus === 'error' && (
                    <div className="test-error text-xs mt-2 text-[var(--nim-error)]">{config.testMessage}</div>
                  )}
                </>
              )}
            </div>
          </div>

          <AvailableModelsSection
            models={availableModels}
            hiddenModels={config.hiddenModels || []}
            loading={loading}
            onVisibilityToggle={onModelVisibilityToggle}
            onSetAllVisible={onSetAllVisible}
          />

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Tool Permissions</h4>
            <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-2">
              Tool permissions are now managed per-project. When Claude Agent attempts to use a tool,
              you'll be prompted to allow or deny the action.
            </p>
            <p className="text-xs leading-relaxed text-[var(--nim-text-muted)]">
              To view or modify allowed tools for a project, go to{' '}
              <strong className="font-medium text-[var(--nim-text)]">Project Settings &gt; Permissions</strong>.
            </p>
          </div>

          {/* Environment Variables are user-level only (~/.claude/settings.json applies
              to every workspace). Hiding this section in the Project tab prevents users
              from believing they're setting a per-project value when they're really
              changing global state. See issue #185. */}
          {scope === 'user' && (
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Environment Variables</h4>
            <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-3">
              Configure environment variables that will be set for all Claude Code sessions.
              These are stored in <code className="text-xs bg-[var(--nim-bg-tertiary)] px-1 py-0.5 rounded">~/.claude/settings.json</code> and apply to every project.
            </p>

            {isLoadingEnv ? (
              <div className="text-sm text-[var(--nim-text-muted)]">Loading...</div>
            ) : (
              <>
                {/* Existing env vars list */}
                {Object.keys(envVars).length > 0 && (
                  <div className="env-vars-list space-y-2 mb-4">
                    {Object.entries(envVars).map(([key, value]) => (
                      <div key={key} className="env-var-row flex items-center gap-2">
                        {editingKey === key ? (
                          <>
                            <input
                              type="text"
                              value={key}
                              disabled
                              className="flex-1 py-1.5 px-2 rounded text-sm bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] text-[var(--nim-text-muted)] font-mono"
                            />
                            <span className="text-[var(--nim-text-muted)]">=</span>
                            <input
                              type="text"
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              className="flex-[2] py-1.5 px-2 rounded text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] font-mono focus:border-[var(--nim-primary)] outline-none"
                              autoFocus
                            />
                            <button
                              onClick={() => {
                                const newEnvVars = { ...envVars, [key]: editingValue };
                                saveEnvVars(newEnvVars);
                                setEditingKey(null);
                                setEditingValue('');
                              }}
                              className="py-1.5 px-3 rounded text-xs font-medium bg-[var(--nim-primary)] text-white hover:bg-[var(--nim-primary-hover)] transition-colors"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => {
                                setEditingKey(null);
                                setEditingValue('');
                              }}
                              className="py-1.5 px-3 rounded text-xs font-medium bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] transition-colors"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="flex-1 py-1.5 px-2 rounded text-sm bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] font-mono truncate">{key}</span>
                            <span className="text-[var(--nim-text-muted)]">=</span>
                            <span className="flex-[2] py-1.5 px-2 rounded text-sm bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] font-mono truncate">{value}</span>
                            <button
                              onClick={() => {
                                setEditingKey(key);
                                setEditingValue(value);
                              }}
                              className="py-1.5 px-3 rounded text-xs font-medium bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] transition-colors"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => {
                                const newEnvVars = { ...envVars };
                                delete newEnvVars[key];
                                saveEnvVars(newEnvVars);
                              }}
                              className="py-1.5 px-3 rounded text-xs font-medium bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] text-[var(--nim-error)] hover:bg-[rgba(239,68,68,0.1)] transition-colors"
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Add new env var form */}
                <div className="add-env-var flex items-center gap-2">
                  <input
                    type="text"
                    value={newEnvKey}
                    onChange={(e) => setNewEnvKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                    placeholder="VARIABLE_NAME"
                    className="flex-1 py-1.5 px-2 rounded text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] font-mono focus:border-[var(--nim-primary)] outline-none"
                  />
                  <span className="text-[var(--nim-text-muted)]">=</span>
                  <input
                    type="text"
                    value={newEnvValue}
                    onChange={(e) => setNewEnvValue(e.target.value)}
                    placeholder="value"
                    className="flex-[2] py-1.5 px-2 rounded text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] font-mono focus:border-[var(--nim-primary)] outline-none"
                  />
                  <button
                    onClick={() => {
                      if (newEnvKey && newEnvKey.trim()) {
                        const newEnvVars = { ...envVars, [newEnvKey.trim()]: newEnvValue };
                        saveEnvVars(newEnvVars);
                        setNewEnvKey('');
                        setNewEnvValue('');
                      }
                    }}
                    disabled={!newEnvKey.trim()}
                    className="py-1.5 px-3 rounded text-xs font-medium bg-[var(--nim-primary)] text-white hover:bg-[var(--nim-primary-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Add
                  </button>
                </div>
              </>
            )}
          </div>
          )}
        </>
      )}

      {/* Claude Code CLI (Subscription) — a separate provider (`claude-code-cli`)
          that runs the genuine `claude` CLI on the user's Pro/Max plan. Enabled
          and trimmed independently of the SDK above. */}
      <div className="provider-panel-section py-4 mb-4 mt-2 border-t border-[var(--nim-border)] last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-base font-semibold mb-1 text-[var(--nim-text)]">Claude Code CLI (Subscription)</h4>
        <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-3">
          Runs the genuine <code className="text-xs bg-[var(--nim-bg-tertiary)] px-1 py-0.5 rounded">claude</code> CLI on your Pro/Max subscription. No API metering. Enable or disable this set independently of the SDK.
        </p>

        <SettingsToggle
          variant="enable"
          name="Enable Claude Code CLI"
          checked={cli.config.enabled ?? true}
          onChange={(checked) => cli.onToggle(checked)}
        />

        {(cli.config.enabled ?? true) && (
          <AvailableModelsSection
            models={cli.availableModels}
            hiddenModels={cli.config.hiddenModels || []}
            loading={cli.loading}
            onVisibilityToggle={cli.onModelVisibilityToggle}
            onSetAllVisible={cli.onSetAllVisible}
          />
        )}
      </div>
    </div>
  );
}
