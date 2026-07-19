import React, { useState, useEffect } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { SettingsToggle } from '../SettingsToggle';
import { HelpTooltip } from '../../../help';
import {
  advancedSettingsAtom,
  setAdvancedSettingsAtom,
  resetWalkthroughsAtom,
  developerFeatureSettingsAtom,
  setDeveloperFeatureSettingsAtom,
  customPathDirsAtom,
  externalEditorSettingsAtom,
  setExternalEditorSettingsAtom,
  EXTERNAL_EDITOR_NAMES,
  DEVELOPER_FEATURES,
  areAllDeveloperFeaturesEnabled,
  enableAllDeveloperFeatures,
  disableAllDeveloperFeatures,
  type ReleaseChannel,
  type ExternalEditorType,
  type PreferredTerminalShell,
} from '../../../store/atoms/appSettings';
import {
  trackerAutomationAtom,
  setTrackerAutomationAtom,
} from '../../../store/atoms/trackerAutomationAtoms';
import {
  multiProjectModeAtom,
  openProjectsAtom,
  activeWorkspacePathAtom,
  restorePreviousProjectsAtom,
} from '../../../store/atoms/openProjects';

/** Reusable compact dropdown row */
function DropdownRow({
  value,
  onChange,
  name,
  description,
  options,
}: {
  value: string | number;
  onChange: (value: string) => void;
  name: string;
  description: string;
  options: { value: string | number; label: string }[];
}) {
  return (
    <div className="setting-item py-2">
      <div className="flex items-center justify-between gap-4">
        <div className="setting-text flex flex-col gap-0 min-w-0">
          <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{name}</span>
          <span className="setting-description text-xs leading-snug text-[var(--nim-text-muted)]">
            {description}
          </span>
        </div>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="setting-select shrink-0 py-1.5 px-2 pr-7 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none appearance-none bg-[url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%236b7280%22%20d%3D%22M3%204.5L6%207.5L9%204.5%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_8px_center] focus:border-[var(--nim-primary)]"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * AdvancedPanel - Self-contained settings panel for advanced options.
 *
 * All settings subscribe directly to Jotai atoms or load via IPC.
 * Developer mode is a global app setting.
 */
export function AdvancedPanel() {
  const posthog = usePostHog();
  // App-level advanced settings from Jotai atoms
  const [settings] = useAtom(advancedSettingsAtom);
  const [, updateSettings] = useAtom(setAdvancedSettingsAtom);
  const [, resetWalkthroughs] = useAtom(resetWalkthroughsAtom);

  // Current enhanced PATH (fetched from main process)
  const [enhancedPath, setEnhancedPath] = useState<string>('');
  const [showEnhancedPath, setShowEnhancedPath] = useState(false);
  const [availableTerminalShells, setAvailableTerminalShells] = useState<Array<{
    name: string;
    path: string;
    provider?: string;
    bootstrapMode?: 'zsh' | 'bash' | 'powershell' | 'none';
    cwdMode?: 'native' | 'wsl';
  }>>([]);

  // Developer feature settings from Jotai atoms
  const [developerSettings] = useAtom(developerFeatureSettingsAtom);
  const [, updateDeveloperSettings] = useAtom(setDeveloperFeatureSettingsAtom);
  const { developerMode, developerFeatures } = developerSettings;

  // Tracker automation settings
  const trackerAutomation = useAtomValue(trackerAutomationAtom);
  const setTrackerAutomation = useSetAtom(setTrackerAutomationAtom);

  // External editor settings from Jotai atoms
  const [externalEditorSettings] = useAtom(externalEditorSettingsAtom);
  const [, updateExternalEditorSettings] = useAtom(setExternalEditorSettingsAtom);
  const { editorType: externalEditorType, customPath: externalEditorCustomPath } = externalEditorSettings;

  // Handle developer mode change
  const handleDeveloperModeChange = async (enabled: boolean) => {
    updateDeveloperSettings({ developerMode: enabled });

    // Track mode change in PostHog
    if (posthog) {
      posthog.capture('developer_mode_changed', {
        developer_mode: enabled,
        source: 'settings',
        is_initial: false,
      });

      // Update person property
      posthog.people.set({ developer_mode: enabled });
    }
  };

  const {
    releaseChannel,
    analyticsEnabled,
    extensionDevToolsEnabled,
    walkthroughsEnabled,
    walkthroughsViewedCount,
    walkthroughsTotalCount,
    maxHeapSizeMB,
    customPathDirs,
    spellcheckEnabled,
    historyMaxAgeDays,
    historyMaxSnapshots,
    preferredTerminalShell,
  } = settings;
  const [showFeaturesMenu, setShowFeaturesMenu] = useState(false);

  // Fetch enhanced PATH when user clicks to show it
  useEffect(() => {
    if (showEnhancedPath && !enhancedPath) {
      window.electronAPI.environment.getEnhancedPath().then(setEnhancedPath);
    }
  }, [showEnhancedPath, enhancedPath]);

  // Refresh enhanced PATH when custom paths change
  useEffect(() => {
    if (showEnhancedPath) {
      window.electronAPI.environment.getEnhancedPath().then(setEnhancedPath);
    }
  }, [customPathDirs, showEnhancedPath]);

  useEffect(() => {
    if (process.platform !== 'win32') {
      return;
    }

    window.electronAPI.terminal.getAvailableShells()
      .then((shells) => setAvailableTerminalShells(shells ?? []))
      .catch((error) => {
        console.error('[AdvancedPanel] Failed to load terminal shells:', error);
        setAvailableTerminalShells([]);
      });
  }, []);

  const terminalShellOptions: Array<{ value: PreferredTerminalShell; label: string }> = [
    { value: 'auto', label: 'Auto (Recommended)' },
  ];
  const seenShellProviders = new Set<PreferredTerminalShell>();
  for (const shell of availableTerminalShells) {
    const provider = shell.provider as PreferredTerminalShell | undefined;
    if (!provider || provider === 'auto' || seenShellProviders.has(provider)) {
      continue;
    }
    seenShellProviders.add(provider);
    const label = shell.name === provider
      ? `${shell.name} (${shell.path})`
      : `${shell.name} [${provider}] (${shell.path})`;
    terminalShellOptions.push({ value: provider, label });
  }

  const handleModeClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setShowFeaturesMenu(prev => !prev);
    }
  };

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
          Advanced Settings
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Advanced configuration options for AI features.
        </p>
      </div>

      {/* Application Mode - Always shown at the top */}
      <div className="provider-panel-section">
          <h4 className="provider-panel-section-title" onClick={handleModeClick}>Application Mode</h4>
          <p className="provider-panel-hint">
            Choose between a simplified experience or full developer features for this project.
          </p>

          <div className="mode-selection flex flex-row gap-4 mt-3">
            <label
              className={`mode-option flex flex-1 items-start p-0 rounded-xl cursor-pointer transition-all relative border-2 ${
                !developerMode
                  ? 'selected bg-nim-hover border-nim-primary shadow-[0_0_0_3px_rgba(88,166,255,0.15)]'
                  : 'bg-nim-secondary border-nim'
              }`}
              onClick={() => handleDeveloperModeChange(false)}
            >
              <input
                type="radio"
                name="mode"
                checked={!developerMode}
                onChange={() => handleDeveloperModeChange(false)}
                className="absolute top-3 right-3 m-0 cursor-pointer w-[18px] h-[18px] accent-[var(--nim-primary)]"
              />
              <div className="p-4 w-full flex flex-col items-center text-center">
                <div className="flex flex-col items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-nim-primary text-[32px]">
                    edit_note
                  </span>
                  <span className="text-base font-semibold text-nim">Standard Mode</span>
                </div>
                <p className="m-0 text-[13px] leading-snug text-nim-muted">
                  Simplified interface focused on writing, editing, and AI assistance
                </p>
              </div>
            </label>

            <label
              className={`mode-option flex flex-1 items-start p-0 rounded-xl cursor-pointer transition-all relative border-2 ${
                developerMode
                  ? 'selected bg-nim-hover border-nim-primary shadow-[0_0_0_3px_rgba(88,166,255,0.15)]'
                  : 'bg-nim-secondary border-nim'
              }`}
              onClick={() => handleDeveloperModeChange(true)}
            >
              <input
                type="radio"
                name="mode"
                checked={developerMode}
                onChange={() => handleDeveloperModeChange(true)}
                className="absolute top-3 right-3 m-0 cursor-pointer w-[18px] h-[18px] accent-[var(--nim-primary)]"
              />
              <div className="p-4 w-full flex flex-col items-center text-center">
                <div className="flex flex-col items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-nim-primary text-[32px]">
                    terminal
                  </span>
                  <span className="text-base font-semibold text-nim">Developer Mode</span>
                </div>
                <p className="m-0 text-[13px] leading-snug text-nim-muted">
                  Full development environment with git worktrees, terminal access, development specific features
                </p>
              </div>
            </label>
          </div>
        </div>

      {/* Secret Features Menu - Cmd+Click on "Application Mode" title to show */}
      {showFeaturesMenu && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
            Feature Availability
          </h4>
          <p className="text-sm leading-relaxed text-[var(--nim-text-muted)] mb-4">
            See which features are available based on your current mode settings.
          </p>

          {/* Developer Features */}
          <div className="mt-4 p-3 bg-nim-secondary rounded-md border border-nim">
            {/* "All Developer Features" master toggle */}
            <div className="setting-item mb-3 pb-3 border-b border-nim">
              <label className="setting-label">
                <input
                  type="checkbox"
                  checked={areAllDeveloperFeaturesEnabled(developerFeatures)}
                  onChange={(e) => {
                    const newFeatures = e.target.checked ? enableAllDeveloperFeatures() : disableAllDeveloperFeatures();
                    updateDeveloperSettings({ developerFeatures: newFeatures });
                  }}
                  disabled={!developerMode}
                  className="setting-checkbox"
                />
                <div className="setting-text">
                  <span className="setting-name">All Developer Features</span>
                  <span className="setting-description">
                    Enable or disable all developer features at once
                  </span>
                </div>
              </label>
            </div>

            {/* Individual developer feature toggles */}
            {DEVELOPER_FEATURES.map((feature) => {
              const isAvailable = developerMode && developerFeatures[feature.tag];
              return (
                <div key={feature.tag} className="setting-item py-2">
                  <label className="setting-label">
                    <input
                      type="checkbox"
                      checked={developerFeatures[feature.tag]}
                      onChange={(e) => {
                        updateDeveloperSettings({
                          developerFeatures: {
                            ...developerFeatures,
                            [feature.tag]: e.target.checked,
                          },
                        });
                      }}
                      disabled={!developerMode}
                      className="setting-checkbox"
                    />
                    <div className="setting-text">
                      <span className="setting-name flex items-center gap-2">
                        {feature.icon && (
                          <span className="material-symbols-outlined text-sm">{feature.icon}</span>
                        )}
                        {feature.name}
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            isAvailable
                              ? 'bg-green-500/20 text-green-400'
                              : 'bg-red-500/20 text-red-400'
                          }`}
                        >
                          {isAvailable ? 'Available' : 'Hidden'}
                        </span>
                      </span>
                      <span className="setting-description">{feature.description}</span>
                    </div>
                  </label>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-[var(--nim-text-faint)] mt-3">
            Developer mode: {developerMode ? 'ON' : 'OFF'}
          </p>
        </div>
      )}

      {/* ── Release Channel ── */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Release Channel</h4>
        <p className="text-sm leading-relaxed text-[var(--nim-text-muted)] mb-4">
          Choose which release stream Nimbalyst pulls auto-updates from. Alpha and beta features are configured separately on each feature&apos;s settings page.
        </p>

        <div className="setting-item py-3">
          <div className="setting-text flex flex-col gap-0.5">
            <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Update Channel</span>
            <span className="setting-description text-xs leading-relaxed text-[var(--nim-text-muted)]">
              <strong>Stable:</strong> Production-ready releases (recommended for most users).<br/>
              <strong>Alpha:</strong> Frequent, rough developer releases. Expect bugs and breaking changes between updates.
            </span>
          </div>
          <select
            value={releaseChannel}
            onChange={(e) => {
              const newChannel = e.target.value as ReleaseChannel;
              updateSettings({ releaseChannel: newChannel });
              posthog?.capture('release_channel_changed', {
                channel: newChannel,
              });
            }}
            className="setting-select mt-2 w-full py-2 px-3 pr-9 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none appearance-none bg-[url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%236b7280%22%20d%3D%22M3%204.5L6%207.5L9%204.5%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_12px_center] focus:border-[var(--nim-primary)]"
          >
            <option value="stable">Stable</option>
            <option value="alpha">Alpha (Developer Releases)</option>
          </select>
        </div>

        {releaseChannel === 'alpha' && (
          <div className="mt-3 flex items-start gap-2 p-3 rounded border border-[var(--nim-warning)]/30 bg-[var(--nim-warning)]/10">
            <MaterialSymbol icon="warning" size={16} className="text-[var(--nim-warning)] shrink-0 mt-0.5" />
            <p className="m-0 text-[13px] text-[var(--nim-text)] leading-snug">
              The alpha channel ships rough developer releases that may be unstable or contain unfinished work. Switch back to Stable if you encounter problems.
            </p>
          </div>
        )}
      </div>

      {/* ── General ── */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">General</h4>

        <MultiProjectModeToggle />

        <RestorePreviousProjectsToggle />

        <SettingsToggle
          checked={analyticsEnabled}
          onChange={(checked) => updateSettings({ analyticsEnabled: checked })}
          name="Send Anonymous Usage Data"
          description="Help improve Nimbalyst by sending anonymous usage data. No prompts or personal info collected."
        />

        <SettingsToggle
          checked={spellcheckEnabled}
          onChange={(checked) => updateSettings({ spellcheckEnabled: checked })}
          name="Spellcheck"
          description="Enable the system spellchecker in editors and text inputs."
        />

        <SettingsToggle
          checked={walkthroughsEnabled}
          onChange={(checked) => updateSettings({ walkthroughsEnabled: checked })}
          name="Show Feature Guides"
          description={`Walkthrough guides for new features and tips.${walkthroughsTotalCount > 0 ? ` (${walkthroughsViewedCount}/${walkthroughsTotalCount} viewed)` : ''}`}
        />

        {walkthroughsViewedCount > 0 && (
          <div className="py-1 pl-7">
            <button onClick={() => resetWalkthroughs()} className="nim-btn-secondary text-xs">
              Reset All Guides
            </button>
          </div>
        )}
      </div>

      {/* ── Tracker Automation ── */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0" data-testid="tracker-automation-section">
        <HelpTooltip testId="tracker-automation-section">
          <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)] inline-block">Tracker Automation</h4>
        </HelpTooltip>

        <SettingsToggle
          checked={trackerAutomation.enabled}
          onChange={(checked) => setTrackerAutomation({ enabled: checked })}
          name="Link Commits to Tracker Items"
          description="Link git commits to tracker items via session relationships and issue key parsing (e.g. NIM-123 in commit messages)."
        />

        {trackerAutomation.enabled && (
          <SettingsToggle
            checked={trackerAutomation.autoCloseOnCommit}
            onChange={(checked) => setTrackerAutomation({ autoCloseOnCommit: checked })}
            name="Close Items on Fixes/Closes/Resolves"
            description="Change tracker item status to done when a commit message uses a closing keyword."
          />
        )}
      </div>

      {/* ── Tools & Environment ── */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">Tools & Environment</h4>

        <DropdownRow
          value={externalEditorType}
          onChange={(val) => updateExternalEditorSettings({ editorType: val as ExternalEditorType })}
          name="External Editor"
          description="Editor for the 'Open in...' context menu option."
          options={[
            { value: 'none', label: 'None' },
            { value: 'vscode', label: 'VS Code' },
            { value: 'cursor', label: 'Cursor' },
            { value: 'webstorm', label: 'WebStorm' },
            { value: 'sublime', label: 'Sublime Text' },
            { value: 'vim', label: 'Vim (Terminal)' },
            { value: 'nvim', label: 'Neovim (Terminal)' },
            { value: 'custom', label: 'Custom...' },
          ]}
        />

        {externalEditorType === 'custom' && (
          <div className="py-2 pl-7">
            <input
              type="text"
              value={externalEditorCustomPath || ''}
              onChange={(e) => updateExternalEditorSettings({ customPath: e.target.value })}
              placeholder={process.platform === 'win32' ? 'C:\\Program Files\\Editor\\editor.exe' : '/usr/local/bin/myeditor'}
              className="w-full py-1.5 px-3 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] font-mono"
            />
          </div>
        )}

        <SettingsToggle
          checked={extensionDevToolsEnabled}
          onChange={(checked) => updateSettings({ extensionDevToolsEnabled: checked })}
          name="Extension Dev Tools"
          description="Enable MCP tools for building, installing, and hot-reloading extensions."
        />

        <DropdownRow
          value={maxHeapSizeMB}
          onChange={(val) => updateSettings({ maxHeapSizeMB: parseInt(val, 10) })}
          name="Max Heap Size"
          description="V8 memory limit. Increase if you get out-of-memory crashes. Requires restart."
          options={[
            { value: 2048, label: '2 GB' },
            { value: 4096, label: '4 GB (Default)' },
            { value: 6144, label: '6 GB' },
            { value: 8192, label: '8 GB' },
            { value: 12288, label: '12 GB' },
            { value: 16384, label: '16 GB' },
          ]}
        />

        {process.platform === 'win32' && (
          <>
            <DropdownRow
              value={preferredTerminalShell}
              onChange={(val) => updateSettings({ preferredTerminalShell: val as PreferredTerminalShell })}
              name="Preferred Terminal Shell"
              description="Choose which detected Windows shell new terminals should open with. Auto follows the built-in priority."
              options={terminalShellOptions}
            />

            <div className="setting-item py-2">
              <div className="setting-text flex flex-col gap-0 mb-2">
                <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Detected Terminal Shells</span>
                <span className="setting-description text-xs leading-snug text-[var(--nim-text-muted)]">
                  Current Windows shell discovery results used for terminal selection and restore.
                </span>
              </div>

              <div className="select-text p-2 rounded-md text-xs bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] text-[var(--nim-text-muted)] font-mono">
                {availableTerminalShells.length === 0 ? (
                  <div>No supported terminal shells detected.</div>
                ) : (
                  availableTerminalShells.map((shell) => (
                    <div key={`${shell.provider || shell.name}-${shell.path}`} className="py-0.5 break-all">
                      {`${shell.provider || shell.name} | ${shell.path} | bootstrap=${shell.bootstrapMode || 'none'} | cwd=${shell.cwdMode || 'native'}`}
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}

        <DropdownRow
          value={historyMaxAgeDays}
          onChange={(val) => updateSettings({ historyMaxAgeDays: parseInt(val, 10) })}
          name="History Retention"
          description="Max age of file history snapshots before automatic cleanup."
          options={[
            { value: 7, label: '7 days' },
            { value: 14, label: '14 days' },
            { value: 30, label: '30 days (Default)' },
            { value: 60, label: '60 days' },
            { value: 90, label: '90 days' },
            { value: 180, label: '180 days' },
            { value: 365, label: '1 year' },
          ]}
        />

        <DropdownRow
          value={historyMaxSnapshots}
          onChange={(val) => updateSettings({ historyMaxSnapshots: parseInt(val, 10) })}
          name="Max Snapshots Per File"
          description="Oldest snapshots beyond this limit are deleted."
          options={[
            { value: 50, label: '50' },
            { value: 100, label: '100' },
            { value: 250, label: '250 (Default)' },
            { value: 500, label: '500' },
            { value: 1000, label: '1,000' },
          ]}
        />

        {/* Custom PATH */}
        <div className="setting-item py-2">
          <div className="setting-text flex flex-col gap-0 mb-2">
            <span className="setting-name text-sm font-medium text-[var(--nim-text)]">Custom PATH Directories</span>
            <span className="setting-description text-xs leading-snug text-[var(--nim-text-muted)]">
              Additional directories for MCP server installation, CLI tool detection, and agent SDK operations.
            </span>
          </div>
          <textarea
            value={customPathDirs}
            onChange={(e) => updateSettings({ customPathDirs: e.target.value })}
            placeholder={process.platform === 'win32'
              ? 'C:\\MyTools;C:\\Programs\\bin'
              : '/opt/mytools/bin:/usr/local/custom/bin'}
            rows={2}
            className="w-full py-1.5 px-3 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] font-mono resize-none"
          />
          <div className="mt-1">
            <button
              onClick={() => setShowEnhancedPath(!showEnhancedPath)}
              className="text-xs text-[var(--nim-link)] hover:text-[var(--nim-link-hover)] cursor-pointer"
            >
              {showEnhancedPath ? 'Hide current PATH' : 'Show current PATH'}
            </button>

            {showEnhancedPath && enhancedPath && (
              <div className="mt-2">
                <div
                  className="p-2 rounded-md text-xs bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] text-[var(--nim-text-muted)] font-mono overflow-x-auto"
                  style={{
                    maxHeight: '200px',
                    overflowY: 'auto',
                    wordBreak: 'break-all',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {enhancedPath.split(process.platform === 'win32' ? ';' : ':').map((p, index) => (
                    <div key={index} className="py-0.5">
                      {p}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

/**
 * Toggle for project tabs. When the user disables it with inactive warm
 * projects, those projects' main-process services are released and the
 * tab strip collapses to just the active
 * project so state stays consistent.
 */
function MultiProjectModeToggle() {
  const [enabled, setEnabled] = useAtom(multiProjectModeAtom);
  const [openProjects, setOpenProjects] = useAtom(openProjectsAtom);
  const activePath = useAtomValue(activeWorkspacePathAtom);

  const handleChange = async (next: boolean) => {
    if (!next && openProjects.length > 1) {
      const proceed = window.confirm(
        `${openProjects.length} project tabs are open. Disable project tabs? The other projects will be closed (their unsaved work stays on disk).`
      );
      if (!proceed) return;

      // Release services for every non-active path before collapsing the
      // rail. The main process refcounts services across windows, so this
      // only frees them when no other window references the path.
      const inactivePaths = openProjects
        .filter((p) => p.path !== activePath)
        .map((p) => p.path);
      await Promise.all(
        inactivePaths.map((path) =>
          window.electronAPI?.invoke?.('workspace:unregister-additional', { workspacePath: path })
            .catch((err: unknown) => {
              console.error('[AdvancedPanel] unregister-additional failed for', path, err);
            })
        )
      );

      const remaining = openProjects.filter((p) => p.path === activePath);
      setOpenProjects(remaining);
    }
    setEnabled(next);
  };

  return (
    <SettingsToggle
      checked={enabled}
      onChange={handleChange}
      name="Open projects in tabs"
      description="Open projects as tabs across the top of the current window. Drag a tab out or use its context menu to open it in a separate window."
    />
  );
}

/**
 * Toggle for re-opening last session's project tabs on launch. Default
 * off so a normal launch from the project picker opens just the picked
 * project; warm tabs must be added explicitly via the tab strip's
 * `+` button.
 */
function RestorePreviousProjectsToggle() {
  const [enabled, setEnabled] = useAtom(restorePreviousProjectsAtom);
  const isMultiProject = useAtomValue(multiProjectModeAtom);

  return (
    <SettingsToggle
      checked={enabled}
      onChange={setEnabled}
      name="Restore last session's projects on launch"
      description={
        isMultiProject
          ? 'When on, the project tabs restore every project that was open at last close. When off, only the project you pick from the launch screen opens.'
          : 'Only takes effect when project tabs are enabled.'
      }
    />
  );
}
