import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { getExtensionLoader } from '@nimbalyst/runtime';
import { store } from '@nimbalyst/runtime/store';
import { SettingsSidebar, type SettingsCategory } from './SettingsSidebar';
import { pushNavigationEntryAtom, isRestoringNavigationAtom } from '../../store';

// Import provider panels from GlobalSettings
import { ClaudePanel } from '../GlobalSettings/panels/ClaudePanel';
import { ClaudeCodePanel } from '../GlobalSettings/panels/ClaudeCodePanel';
import { OpenAIPanel } from '../GlobalSettings/panels/OpenAIPanel';
import { OpenAICodexPanel } from '../GlobalSettings/panels/OpenAICodexPanel';
import { OpenCodePanel } from '../GlobalSettings/panels/OpenCodePanel';
import { CopilotCLIPanel } from '../GlobalSettings/panels/CopilotCLIPanel';
import { LMStudioPanel } from '../GlobalSettings/panels/LMStudioPanel';
import { AdvancedPanel } from '../GlobalSettings/panels/AdvancedPanel';
import { DatabasePanel } from '../GlobalSettings/panels/DatabasePanel';
import { AgentFeaturesPanel } from './AgentFeaturesPanel';
import { BetaFeaturesPanel } from '../GlobalSettings/panels/BetaFeaturesPanel';
import { NotificationsPanel } from '../GlobalSettings/panels/NotificationsPanel';
import { VoiceModePanel } from './VoiceModePanel';
import { MCPServersPanel } from '../GlobalSettings/panels/MCPServersPanel';
import { ClaudeCodePluginsPanel } from '../GlobalSettings/panels/ClaudeCodePluginsPanel';
import { SyncPanel } from '../GlobalSettings/panels/SyncPanel';
import { SharedLinksPanel } from '../GlobalSettings/panels/SharedLinksPanel';
import { ProjectPermissionsPanel } from './panels/ProjectPermissionsPanel';
import { ProviderOverrideWrapper } from './panels/ProviderOverrideWrapper';
import { InstalledExtensionsPanel } from './panels/InstalledExtensionsPanel';
import { PrivilegedExtensionsPanel } from './panels/PrivilegedExtensionsPanel';
import { ThemesPanel } from './panels/ThemesPanel';
import { TeamPanel } from './panels/TeamPanel';
import { TrackerConfigPanel } from './panels/TrackerConfigPanel';
import { GitHubAccountPanel } from './panels/GitHubAccountPanel';
import { ExtensionMarketplacePanel } from './panels/ExtensionMarketplacePanel';
import { walkthroughs } from '../../walkthroughs';
import {
  aiProviderSettingsAtom,
  developerModeAtom,
  setAIProviderSettingsAtom,
  setProviderConfigAtom,
  setApiKeyAtom,
  setAvailableModelsAtom,
  flushPendingAIProviderPersist,
  type ProviderConfig,
  type AIModel,
} from '../../store/atoms/appSettings';
import { omitModelsField } from '@nimbalyst/runtime/ai/server/utils/modelConfigUtils';

// Re-export ProviderConfig for backward compatibility
export type { ProviderConfig } from '../../store/atoms/appSettings';

// Keep Model interface here since it may differ slightly from AIModel
export interface Model {
  id: string;
  name: string;
  provider: string;
}

// Note: The ProviderConfig interface has been moved to appSettings.ts

export type SettingsScope = 'user' | 'project';

interface MarketplaceInstallRequest {
  extensionId: string;
  requestedAt: string;
  token: number;
}

interface SettingsViewProps {
  workspacePath?: string | null;
  workspaceName?: string | null;
  onClose: () => void;
  initialCategory?: SettingsCategory;
  initialScope?: SettingsScope;
  marketplaceInstallRequest?: MarketplaceInstallRequest | null;
  onMarketplaceInstallRequestHandled?: (token: number) => void;
}

type ExtAgentItem = {
  id: string;
  extensionId: string;
  name: string;
  status: string;
  models?: Array<{ id: string; name: string }>;
};

/**
 * Renders an extension-contributed agent provider's own settings panel (e.g. the
 * Gemini AntigravityAgentSettings component), wired with the same provider props
 * the built-in panels use plus the backend-module grant flow:
 *   backendModuleEnabled  <- ext-permissions:is-module-enabled (grant state)
 *   onEnableBackendModule -> ext-permissions:grant-module (the native-code consent)
 * Falls back to a static notice when the extension's component is unavailable.
 */
const ExtensionAgentSettingsPanel: React.FC<{
  extEntry: ExtAgentItem;
  commonProps: Record<string, unknown>;
  workspacePath?: string;
  scope: 'user' | 'project';
  onOpenInstalledExtensions: () => void;
}> = ({ extEntry, commonProps, workspacePath, scope, onOpenInstalledExtensions }) => {
  const loadedExt = getExtensionLoader().getExtension(extEntry.extensionId);
  const contributions = (loadedExt?.manifest?.contributions ?? {}) as Record<string, unknown>;
  const aiProviders = contributions.aiAgentProviders as
    | Array<{ id: string; backendModuleId?: string; settingsPanelComponent?: string }>
    | undefined;
  const providerContribution = aiProviders?.find((pr) => pr.id === extEntry.id);
  const moduleId = providerContribution?.backendModuleId;
  const componentName = providerContribution?.settingsPanelComponent;
  const backendModules = contributions.backendModules as
    | Array<{ id: string; permissions?: string[] }>
    | undefined;
  const declaredPermissions = (backendModules?.find((m) => m.id === moduleId)?.permissions ?? []) as string[];
  const settingsPanelExports = (loadedExt?.module as { settingsPanel?: Record<string, React.ComponentType<Record<string, unknown>>> } | undefined)?.settingsPanel;
  const ExtPanel = componentName ? settingsPanelExports?.[componentName] : undefined;

  // The permissions bridge lives at electronAPI.extensions.permissions (not
  // electronAPI.permissions). The existing Privileged Capabilities UI uses the
  // same path; reading the wrong one leaves perms undefined, which silently
  // disables both the grant check and the Enable-provider button.
  const perms = (window.electronAPI as {
    extensions?: {
      permissions?: {
        listEnabledModules?: (workspacePath?: string) => Promise<Array<{ extensionId: string; moduleId: string }>>;
        isModuleEnabled?: (a: { extensionId: string; moduleId: string; declaredPermissions: string[]; workspacePath?: string }) => Promise<boolean>;
        grantModule: (a: { extensionId: string; moduleId: string; permissions: string[]; scope: 'workspace' | 'global'; workspacePath?: string }) => Promise<unknown>;
        onStateChanged?: (cb: (h: { extensionId: string; moduleId: string }) => void) => () => void;
      };
    };
  } | undefined)?.extensions?.permissions;

  const [granted, setGranted] = useState(false);
  const permsKey = declaredPermissions.join(',');

  const refreshGrant = useCallback(async () => {
    if (!perms || !moduleId) return;
    try {
      // Robust host-truth: listEnabledModules returns every module that has
      // any grant row (real permission OR the module-enabled sentinel), so it
      // does not depend on the renderer passing an exact declaredPermissions
      // set that matches what was granted.
      let ok = false;
      if (typeof perms.listEnabledModules === 'function') {
        const mods = await perms.listEnabledModules(workspacePath);
        ok = Array.isArray(mods) && mods.some(
          (m) => m.extensionId === extEntry.extensionId && m.moduleId === moduleId
        );
      }
      if (!ok && typeof perms.isModuleEnabled === 'function') {
        ok = Boolean(await perms.isModuleEnabled({ extensionId: extEntry.extensionId, moduleId, declaredPermissions, workspacePath }));
      }
      setGranted(ok);
    } catch (err) {
      console.error('[ext-agent-settings] grant check failed', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perms, moduleId, extEntry.extensionId, workspacePath, permsKey]);

  useEffect(() => { void refreshGrant(); }, [refreshGrant]);
  useEffect(() => {
    if (!perms?.onStateChanged) return;
    return perms.onStateChanged((h) => {
      if (h.extensionId === extEntry.extensionId && h.moduleId === moduleId) void refreshGrant();
    });
  }, [perms, extEntry.extensionId, moduleId, refreshGrant]);

  if (!ExtPanel) {
    return (
      <div className="settings-extension-provider-panel">
        <h2 className="text-lg font-semibold text-[var(--nim-text)] mb-2">{extEntry.name || extEntry.id}</h2>
        <p className="text-sm text-[var(--nim-text-muted)] mb-4 max-w-[60ch]">
          This agent provider comes from an installed extension. Choose its models from the model
          selector in the chat input. To configure or manage the extension, open Installed Extensions.
        </p>
        <button
          type="button"
          className="px-3 py-1.5 rounded text-xs bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]"
          onClick={onOpenInstalledExtensions}
        >
          Open Installed Extensions
        </button>
      </div>
    );
  }

  const cfg = (commonProps.config as Record<string, unknown> | undefined) ?? {};
  const extModels = (extEntry.models ?? []).map((m) => ({ id: m.id, name: m.name, provider: extEntry.id }));
  return (
    <ExtPanel
      {...commonProps}
      config={{ ...cfg, backendModuleEnabled: granted }}
      availableModels={extModels}
      onEnableBackendModule={async () => {
        if (!perms || !moduleId) {
          throw new Error(
            !perms
              ? 'Permissions bridge unavailable in this host.'
              : 'Backend module id missing from the extension manifest.'
          );
        }
        try {
          await perms.grantModule({
            extensionId: extEntry.extensionId,
            moduleId,
            permissions: declaredPermissions,
            scope: scope === 'project' ? 'workspace' : 'global',
            workspacePath,
          });
        } catch (err) {
          console.error('[ext-agent-settings] grantModule failed', err);
          throw err;
        } finally {
          await refreshGrant();
        }
      }}
    />
  );
};

export function SettingsView({
  workspacePath,
  workspaceName,
  onClose,
  initialCategory,
  initialScope,
  marketplaceInstallRequest = null,
  onMarketplaceInstallRequestHandled,
}: SettingsViewProps) {
  const posthog = usePostHog();
  const developerMode = useAtomValue(developerModeAtom);

  const [selectedCategory, setSelectedCategory] = useState<SettingsCategory | string>(initialCategory || 'claude-code');
  // Extension-contributed agent providers (id, owning extension, live status,
  // static model list) so the provider settings page can render the extension's
  // own panel component (e.g. Gemini Antigravity) wired like a built-in panel.
  const [extAgentProviders, setExtAgentProviders] = useState<
    Array<{ id: string; extensionId: string; name: string; status: string; models?: Array<{ id: string; name: string }> }>
  >([]);
  const refreshExtAgentProviders = useCallback(() => {
    const invoke = window.electronAPI?.invoke;
    if (!invoke) return;
    invoke('agent-providers:list')
      .then((res: { success?: boolean; data?: Array<{ id: string; extensionId: string; name: string; status: string; models?: Array<{ id: string; name: string }> }> }) => {
        if (res?.success && Array.isArray(res.data)) setExtAgentProviders(res.data);
      })
      .catch(() => { /* registry unavailable; static fallback panel is used */ });
  }, []);
  useEffect(() => { refreshExtAgentProviders(); }, [refreshExtAgentProviders]);
  const [scope, setScope] = useState<SettingsScope>(initialScope || 'user');

  // AI Provider settings - using Jotai atoms (Phase 5b)
  const [aiProviderSettings] = useAtom(aiProviderSettingsAtom);
  const [, updateAIProviderSettings] = useAtom(setAIProviderSettingsAtom);
  const [, updateProviderConfig] = useAtom(setProviderConfigAtom);
  const [, updateApiKey] = useAtom(setApiKeyAtom);
  const [, updateAvailableModels] = useAtom(setAvailableModelsAtom);

  // Destructure for easier access (these update when atom updates)
  const { providers, apiKeys, availableModels } = aiProviderSettings;

  // Local setters that wrap atom updates for backward compatibility
  const setProviders = useCallback((updater: Record<string, ProviderConfig> | ((prev: Record<string, ProviderConfig>) => Record<string, ProviderConfig>)) => {
    if (typeof updater === 'function') {
      const latestProviders = store.get(aiProviderSettingsAtom).providers;
      const newProviders = updater(latestProviders);
      updateAIProviderSettings({ providers: newProviders });
    } else {
      updateAIProviderSettings({ providers: updater });
    }
  }, [updateAIProviderSettings]);

  const setApiKeys = useCallback((updater: Record<string, string> | ((prev: Record<string, string>) => Record<string, string>)) => {
    if (typeof updater === 'function') {
      const latestApiKeys = store.get(aiProviderSettingsAtom).apiKeys;
      const newApiKeys = updater(latestApiKeys);
      updateAIProviderSettings({ apiKeys: newApiKeys });
    } else {
      updateAIProviderSettings({ apiKeys: updater });
    }
  }, [updateAIProviderSettings]);

  const setAvailableModels = useCallback((updater: Record<string, Model[]> | ((prev: Record<string, Model[]>) => Record<string, Model[]>)) => {
    if (typeof updater === 'function') {
      const latestModels = store.get(aiProviderSettingsAtom).availableModels as Record<string, Model[]>;
      const newModels = updater(latestModels);
      updateAIProviderSettings({ availableModels: newModels });
    } else {
      updateAIProviderSettings({ availableModels: updater });
    }
  }, [updateAIProviderSettings]);

  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Ref to track if we need to save (for debounce)
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingSaveRef = useRef(false);
  const performSaveRef = useRef<() => Promise<void>>();
  // NOTE: Notification settings (Phase 2), Advanced settings (Phase 3), Sync settings (Phase 4),
  // AI debug settings (Phase 5), AI provider settings (Phase 5b), and Voice mode settings (Phase 7)
  // have been moved to Jotai atoms in appSettings.ts
  // Panels now subscribe directly to atoms - settings are auto-persisted via atom setters

  // Track if workspace has MCP servers (for indicator on Project tab)
  const [hasWorkspaceMcpServers, setHasWorkspaceMcpServers] = useState(false);
  const [workspaceMcpServerCount, setWorkspaceMcpServerCount] = useState(0);

  // Valid categories for each scope
  const projectCategories: SettingsCategory[] = [
    'agent-permissions',
    'team',
    'tracker-config',
    ...(developerMode ? (['github'] as SettingsCategory[]) : []),
    'installed-extensions',
    'claude-plugins',
    'mcp-servers',
    'claude-code',
    'claude',
    'openai',
    'openai-codex',
    'opencode',
    'copilot-cli',
    'lmstudio',
  ];
  const userCategories: SettingsCategory[] = [
    'claude-code',
    'claude',
    'openai',
    'openai-codex',
    'opencode',
    'copilot-cli',
    'lmstudio',
    ...(developerMode ? (['github'] as SettingsCategory[]) : []),
    'sync',
    'notifications',
    'voice-mode',
    'agent-features',
    'advanced',
    'marketplace',
    'installed-extensions',
    'claude-plugins',
    'mcp-servers',
  ];

  // When initialCategory/initialScope props change, update state (for deep linking)
  useEffect(() => {
    if (initialCategory) {
      setSelectedCategory(initialCategory);
    }
    if (initialScope) {
      setScope(initialScope);
    }
  }, [initialCategory, initialScope]);

  // Push navigation entry when settings category/scope changes (unified cross-mode navigation)
  const pushNavigationEntry = useSetAtom(pushNavigationEntryAtom);
  const isRestoringNavigation = useAtomValue(isRestoringNavigationAtom);
  const lastNavigationRef = useRef<string | null>(null);

  useEffect(() => {
    // Don't push while restoring (going back/forward)
    if (isRestoringNavigation) return;

    const navKey = `${selectedCategory}:${scope}`;
    if (navKey !== lastNavigationRef.current) {
      lastNavigationRef.current = navKey;
      pushNavigationEntry({
        mode: 'settings',
        settings: {
          category: selectedCategory,
          scope,
        },
      });
    }
  }, [selectedCategory, scope, pushNavigationEntry, isRestoringNavigation]);

  // When scope changes, ensure selected category is valid for that scope
  useEffect(() => {
    const validCategories = scope === 'project' ? projectCategories : userCategories;
    // Extension-contributed agent providers (e.g. antigravity-gemini-agent) are
    // valid selectable categories too; don't bounce the user off them.
    const isExtensionProvider = extAgentProviders.some((pr) => pr.id === selectedCategory);
    if (!isExtensionProvider && !validCategories.includes(selectedCategory as SettingsCategory)) {
      // Default to first valid category for the scope
      setSelectedCategory(scope === 'project' ? 'agent-permissions' : 'claude-code');
    }
  }, [scope, selectedCategory, developerMode, extAgentProviders]);

  useEffect(() => {
    if (!developerMode && selectedCategory === 'github') {
      setSelectedCategory(scope === 'project' ? 'agent-permissions' : 'claude-code');
    }
  }, [developerMode, selectedCategory, scope]);

  // Load settings on mount
  useEffect(() => {
    loadSettings();
  }, []);

  // Check if workspace has MCP servers (for indicator on Project tab when in global scope)
  useEffect(() => {
    const checkWorkspaceMcpServers = async () => {
      if (workspacePath && scope === 'user') {
        try {
          const config = await window.electronAPI.invoke('mcp-config:read-workspace', workspacePath);
          const serverCount = config?.mcpServers ? Object.keys(config.mcpServers).length : 0;
          const hasServers = serverCount > 0;
          setHasWorkspaceMcpServers(hasServers);
          setWorkspaceMcpServerCount(serverCount);
        } catch (error) {
          console.error('Failed to check workspace MCP servers:', error);
          setHasWorkspaceMcpServers(false);
          setWorkspaceMcpServerCount(0);
        }
      } else {
        setHasWorkspaceMcpServers(false);
        setWorkspaceMcpServerCount(0);
      }
    };

    checkWorkspaceMcpServers();
  }, [workspacePath, scope, selectedCategory]);

  const loadSettings = async () => {
    // NOTE: Most settings are now loaded via Jotai atoms initialized in index.tsx:
    // - AI provider settings (providers, apiKeys) - Phase 5b
    // - AI debug settings (showToolCalls, aiDebugLogging) - Phase 5
    // - Notification settings - Phase 2
    // - Advanced settings (including release channel) - Phase 3
    // - Sync config - Phase 4
    // - Voice mode settings - Phase 7

    // Fetch available models - cached in atom but not persisted
    try {
      const response = await window.electronAPI.aiGetAllModels();
      if (response.success && response.grouped) {
        setAvailableModels(response.grouped);
      }
    } catch (error) {
      console.error('Failed to fetch initial models:', error);
    }

    // Re-hydrate extension-contributed agent providers from persisted settings.
    // The provider atom is seeded once at app startup, which can predate an
    // extension's enable-on-activate write (e.g. Gemini enabling itself + its
    // models on first detection). Re-reading here, additively, makes the panel
    // reflect that write without a restart. Built-in providers are already in
    // the atom, so this only fills in keys the atom is missing - it never
    // clobbers an in-flight edit.
    try {
      const persisted = await window.electronAPI.aiGetSettings();
      const providerSettings = (persisted?.providerSettings ?? {}) as Record<string, ProviderConfig>;
      if (Object.keys(providerSettings).length > 0) {
        setProviders((prev) => {
          let changed = false;
          const next = { ...prev };
          for (const [key, value] of Object.entries(providerSettings)) {
            if (!(key in next)) {
              next[key] = { testStatus: 'idle', ...value, enabled: value.enabled ?? false };
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
    } catch (error) {
      console.error('Failed to re-hydrate extension provider settings:', error);
    }
  };

  const handleProviderToggle = async (provider: string, enabled: boolean) => {
    if (enabled && (provider === 'claude-code' || provider === 'openai-codex' || provider === 'opencode' || provider === 'copilot-cli')) {
      await fetchModels(provider);
    }

    setProviders(prev => {
      let models = prev[provider]?.models || [];

      if (enabled && provider === 'claude-code') {
        const providerModels = availableModels[provider] || [];
        if (providerModels.length > 0 && models.length === 0) {
          models = [providerModels[0].id];
        }
      }

      posthog?.capture('ai_provider_configured', {
        provider,
        modelCount: (provider === 'openai-codex' || provider === 'opencode' || provider === 'copilot-cli') ? 0 : models.length,
        action: enabled ? 'enabled' : 'disabled'
      });

      // OpenAI Codex and OpenCode use dynamic model discovery, not user selection
      if (provider === 'openai-codex' || provider === 'opencode' || provider === 'copilot-cli') {
        const currentProvider = prev[provider] || { enabled: false };
        return {
          ...prev,
          [provider]: {
            ...omitModelsField(currentProvider),
            enabled
          }
        };
      }

      return {
        ...prev,
        [provider]: {
          ...prev[provider],
          enabled,
          models
        }
      };
    });
    debouncedSave();

    if (enabled && provider !== 'claude-code' && provider !== 'openai-codex' && provider !== 'opencode' && provider !== 'copilot-cli') {
      fetchModels(provider);
    }
  };

  const handleApiKeyChange = (key: string, value: string) => {
    setApiKeys(prev => ({ ...prev, [key]: value }));
    debouncedSave();
  };

  const fetchModels = async (provider: string) => {
    setLoading(prev => ({ ...prev, [provider]: true }));

    try {
      const response = await window.electronAPI.aiGetAllModels();
      if (response.success && response.grouped) {
        setAvailableModels(response.grouped);
      }
    } catch (error) {
      console.error(`Failed to fetch models for ${provider}:`, error);
    } finally {
      setLoading(prev => ({ ...prev, [provider]: false }));
    }
  };

  // Perform the actual save
  // NOTE: Most settings are now auto-saved via Jotai atom setters.
  // This function now primarily handles model cache clearing and feedback.
  const performSave = useCallback(async () => {
    if (!pendingSaveRef.current) return;
    pendingSaveRef.current = false;

    try {
      setSaveStatus('saving');

      // NOTE: AI provider settings (providers, apiKeys) are saved automatically via Jotai atoms (Phase 5b)
      // Notification settings (Phase 2), Advanced settings (Phase 3), Sync settings (Phase 4),
      // AI debug settings (Phase 5), and Voice mode settings are all saved via atom setters

      // Clear the model cache to force refresh with new API keys
      await window.electronAPI.aiClearModelCache?.();

      setSaveStatus('saved');

      // Reset status after a delay
      setTimeout(() => setSaveStatus('idle'), 2000);

      // Refresh models for all enabled providers in the background
      Promise.all(
        Object.entries(providers)
          .filter(([_, config]) => config.enabled)
          .map(([provider, _]) => fetchModels(provider))
      ).catch(error => {
        console.error('Failed to refresh models in background:', error);
      });
    } catch (error) {
      console.error('Failed to save settings:', error);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [providers]);

  // Keep the ref in sync with performSave so debounced calls use the latest version
  performSaveRef.current = performSave;

  // Debounced save - call this when settings change
  // Uses a ref to avoid stale closure issues with the timeout
  const debouncedSave = useCallback(() => {
    pendingSaveRef.current = true;

    // Clear any existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Set new timeout - 500ms debounce
    // Use ref to always call the latest performSave
    saveTimeoutRef.current = setTimeout(() => {
      performSaveRef.current?.();
    }, 500);
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        // Save immediately on unmount if there are pending changes
        if (pendingSaveRef.current) {
          performSaveRef.current?.();
        }
      }
    };
  }, []);

  // Build provider status for sidebar
  const providerStatus = Object.fromEntries(
    Object.entries(providers).map(([id, config]) => [
      id,
      { enabled: config.enabled, testStatus: config.testStatus }
    ])
  );

  const renderPanel = () => {
    // Project panels
    if (selectedCategory === 'agent-permissions' && workspacePath) {
      return (
        <ProjectPermissionsPanel
          workspacePath={workspacePath}
          workspaceName={workspaceName || 'Project'}
        />
      );
    }

    // Provider panels
    const commonProps = {
      config: providers[selectedCategory] || { enabled: false, testStatus: 'idle' },
      apiKeys,
      availableModels: availableModels[selectedCategory] || [],
      loading: loading[selectedCategory] || false,
      onToggle: (enabled: boolean) => handleProviderToggle(selectedCategory, enabled),
      onApiKeyChange: handleApiKeyChange,
      onModelToggle: (modelId: string, enabled: boolean) => {
        // OpenAI Codex, OpenCode, and Copilot don't support user model selection - models are discovered dynamically
        if (selectedCategory === 'openai-codex' || selectedCategory === 'opencode' || selectedCategory === 'copilot-cli') {
          return;
        }

        setProviders(prev => {
          const models = prev[selectedCategory]?.models || [];
          const updated = enabled
            ? [...models, modelId]
            : models.filter(m => m !== modelId);

          if (enabled) {
            const modelName = modelId.includes(':') ? modelId.split(':')[1] : modelId;
            posthog?.capture('ai_model_selected', {
              provider: selectedCategory,
              modelName
            });
          }

          return {
            ...prev,
            [selectedCategory]: { ...prev[selectedCategory], models: updated }
          };
        });
        debouncedSave();
      },
      onSelectAllModels: (selectAll: boolean) => {
        // OpenAI Codex, OpenCode, and Copilot don't support user model selection - models are discovered dynamically
        if (selectedCategory === 'openai-codex' || selectedCategory === 'opencode' || selectedCategory === 'copilot-cli') {
          return;
        }

        if (selectAll) {
          const models = availableModels[selectedCategory] || [];
          setProviders(prev => ({
            ...prev,
            [selectedCategory]: { ...prev[selectedCategory], models: models.map(m => m.id) }
          }));
        } else {
          setProviders(prev => ({
            ...prev,
            [selectedCategory]: { ...prev[selectedCategory], models: [] }
          }));
        }
        debouncedSave();
      },
      onTestConnection: async () => {
        setProviders(prev => ({
          ...prev,
          [selectedCategory]: { ...prev[selectedCategory], testStatus: 'testing', testMessage: undefined }
        }));

        // Ensure any debounced provider/apiKey changes are saved before testing
        // so the main process has the keys the user just typed. We flush the
        // pending diff rather than sending the full atom -- sending the full
        // atom was how stale defaults could clobber real stored settings.
        await flushPendingAIProviderPersist();

        try {
          const result = await window.electronAPI.aiTestConnection(
            selectedCategory,
            workspacePath ?? undefined
          );

          setProviders(prev => ({
            ...prev,
            [selectedCategory]: {
              ...prev[selectedCategory],
              testStatus: result.success ? 'success' : 'error',
              testMessage: result.success ? 'Connected' : result.error
            }
          }));

          if (result.success) {
            await window.electronAPI.aiClearModelCache?.();
            await fetchModels(selectedCategory);
          }
        } catch (error) {
          setProviders(prev => ({
            ...prev,
            [selectedCategory]: {
              ...prev[selectedCategory],
              testStatus: 'error',
              testMessage: 'Connection failed'
            }
          }));
        }
      },
      onConfigChange: (updates: Partial<ProviderConfig>) => {
        setProviders(prev => ({
          ...prev,
          [selectedCategory]: { ...prev[selectedCategory], ...updates }
        }));
        debouncedSave();
      }
    };

    // Helper to wrap provider panels with override wrapper when in project scope
    const wrapWithOverride = (providerId: string, providerName: string, panel: React.ReactNode) => {
      if (scope === 'project' && workspacePath) {
        return (
          <ProviderOverrideWrapper
            providerId={providerId}
            providerName={providerName}
            workspacePath={workspacePath}
            workspaceName={workspaceName || 'Project'}
            globalEnabled={providers[providerId]?.enabled ?? false}
            onOverrideChange={() => loadSettings()}
          >
            {panel}
          </ProviderOverrideWrapper>
        );
      }
      return panel;
    };

    switch (selectedCategory) {
      case 'claude':
        return wrapWithOverride('claude', 'Claude', <ClaudePanel {...commonProps} />);
      case 'claude-code':
        return wrapWithOverride(
          'claude-code',
          'Claude Agent',
          <ClaudeCodePanel
            {...commonProps}
            scope={scope === 'project' ? 'project' : 'user'}
            workspacePath={scope === 'project' ? workspacePath ?? undefined : undefined}
          />,
        );
      case 'openai':
        return wrapWithOverride('openai', 'OpenAI', <OpenAIPanel {...commonProps} />);
      case 'openai-codex':
        return wrapWithOverride('openai-codex', 'OpenAI Codex', <OpenAICodexPanel {...commonProps} />);
      case 'opencode':
        return wrapWithOverride('opencode', 'OpenCode', <OpenCodePanel {...commonProps} />);
      case 'copilot-cli':
        return wrapWithOverride('copilot-cli', 'GitHub Copilot', <CopilotCLIPanel {...commonProps} />);
      case 'lmstudio':
        return wrapWithOverride('lmstudio', 'LM Studio', <LMStudioPanel {...commonProps} />);
      case 'advanced':
        // AdvancedPanel is self-contained - uses Jotai atoms and IPC directly
        return <AdvancedPanel />;
      case 'database':
        // DatabasePanel exposes the SQLite migration controls (dry-run, gated
        // "Migrate now", rollback). Self-contained; talks to MigrationHandlers
        // IPC directly. See packages/electron/src/main/ipc/MigrationHandlers.ts.
        return <DatabasePanel />;
      case 'agent-features':
        return <AgentFeaturesPanel />;
      case 'beta-features':
        return <BetaFeaturesPanel />;
      case 'notifications':
        // NotificationsPanel is now self-contained - uses Jotai atoms directly
        return <NotificationsPanel />;
      case 'voice-mode':
        // VoiceModePanel is now self-contained - uses Jotai atoms directly
        return <VoiceModePanel workspacePath={workspacePath ?? undefined} />;
      case 'installed-extensions':
        return (
          <InstalledExtensionsPanel
            scope={scope}
            workspacePath={workspacePath ?? undefined}
          />
        );
      case 'privileged-extensions':
        return <PrivilegedExtensionsPanel workspacePath={workspacePath ?? undefined} />;
      case 'mcp-servers':
        return (
          <>
            {hasWorkspaceMcpServers && scope === 'user' && (
              <div className="settings-project-indicator flex items-start gap-3 py-3 px-4 mb-6 bg-[rgba(59,130,246,0.1)] border border-[rgba(59,130,246,0.3)] rounded-lg text-[var(--nim-text)] [&_.material-symbols-outlined]:text-[var(--nim-info)] [&_.material-symbols-outlined]:shrink-0 [&_.material-symbols-outlined]:mt-0.5">
                <MaterialSymbol icon="info" size={20} />
                <div className="settings-project-indicator-text flex flex-col gap-1">
                  <strong className="text-sm font-semibold text-[var(--nim-text)]">
                    There {workspaceMcpServerCount === 1 ? 'is' : 'are'} {workspaceMcpServerCount} additional MCP {workspaceMcpServerCount === 1 ? 'server' : 'servers'} configured just for this project.
                  </strong>
                  <span className="text-[13px] text-[var(--nim-text-muted)] leading-[1.4]">Switch to the Project tab above to view or edit project-specific MCP servers.</span>
                </div>
              </div>
            )}
            <MCPServersPanel
              scope={scope === 'project' ? 'workspace' : 'user'}
              workspacePath={scope === 'project' ? workspacePath ?? undefined : undefined}
            />
          </>
        );
      case 'claude-plugins':
        return (
          <ClaudeCodePluginsPanel
            scope={scope === 'project' ? 'workspace' : 'user'}
            workspacePath={scope === 'project' ? workspacePath ?? undefined : undefined}
          />
        );
      case 'sync':
        return <SyncPanel />;
      case 'shared-links':
        return <SharedLinksPanel />;
      case 'themes':
        return (
          <ThemesPanel
            scope={scope}
            workspacePath={workspacePath ?? undefined}
          />
        );
      case 'team':
        return <TeamPanel workspacePath={workspacePath ?? undefined} />;
      case 'tracker-config':
        return <TrackerConfigPanel workspacePath={workspacePath ?? undefined} />;
      case 'github':
        if (!developerMode) {
          return null;
        }
        return (
          <GitHubAccountPanel
            scope={scope}
            workspacePath={workspacePath ?? undefined}
          />
        );
      case 'marketplace':
        return (
          <ExtensionMarketplacePanel
            installRequest={marketplaceInstallRequest}
            onInstallRequestHandled={onMarketplaceInstallRequestHandled}
            onViewInstalled={() => setSelectedCategory('installed-extensions')}
          />
        );
      default: {
        // An extension-contributed agent provider (e.g. antigravity-gemini-agent)
        // was selected. Its models are usable from the chat model picker; its
        // configuration lives in the extension, reachable from Installed Extensions.
        const providerId = String(selectedCategory);
        // Render the extension's own provider settings panel (declared via
        // aiAgentProviders[].settingsPanelComponent), wired with the same props the
        // built-in panels receive. Falls back to the static notice below when the
        // component is unavailable.
        const extEntry = extAgentProviders.find((pr) => pr.id === providerId);
        if (extEntry) {
          return (
            <ExtensionAgentSettingsPanel
              extEntry={extEntry}
              commonProps={commonProps as unknown as Record<string, unknown>}
              workspacePath={workspacePath ?? undefined}
              scope={scope}
              onOpenInstalledExtensions={() => setSelectedCategory('installed-extensions')}
            />
          );
        }
        const label = providerId
          .replace(/-agent$/, '')
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());
        return (
          <div className="settings-extension-provider-panel">
            <h2 className="text-lg font-semibold text-[var(--nim-text)] mb-2">{label}</h2>
            <p className="text-sm text-[var(--nim-text-muted)] mb-4 max-w-[60ch]">
              This agent provider comes from an installed extension. Choose its models from the
              model selector in the chat input. To configure or manage the extension, open Installed
              Extensions.
            </p>
            <button
              type="button"
              className="px-3 py-1.5 rounded text-xs bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]"
              onClick={() => setSelectedCategory('installed-extensions')}
            >
              Open Installed Extensions
            </button>
          </div>
        );
      }
    }
  };

  // Categories that are only available in project scope
  const projectOnlyCategories: SettingsCategory[] = ['agent-permissions', 'team', 'tracker-config'];

  // Handle scope changes - preserve selected category when possible
  const handleScopeChange = (newScope: SettingsScope) => {
    setScope(newScope);
    // Only change category if current one is not available in the new scope
    if (newScope === 'user' && projectOnlyCategories.includes(selectedCategory as SettingsCategory)) {
      // Switching to user scope from a project-only category
      setSelectedCategory('claude-code');
    }
    // When switching to project scope, keep the current category (all user categories are available in project scope)
  };

  return (
    <div className="settings-view flex flex-col h-full bg-[var(--nim-bg)] text-[var(--nim-text)]">
      {/* Settings Header */}
      <header className="settings-view-header h-[52px] bg-[var(--nim-bg-secondary)] border-b border-[var(--nim-border)] flex items-center px-5 gap-4 shrink-0">
        <h1 className="settings-view-title text-base font-semibold text-[var(--nim-text)] m-0">Settings</h1>

        <div className="settings-scope-container flex items-center gap-3">
          <div className="settings-scope-tabs flex bg-[var(--nim-bg-tertiary)] p-1 rounded-lg">
            <button
              className={`settings-scope-tab py-1.5 px-4 rounded-md text-xs font-medium cursor-pointer transition-all duration-150 border-none ${
                scope === 'user'
                  ? 'bg-[var(--nim-primary)] text-white shadow-sm'
                  : 'bg-transparent text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
              }`}
              onClick={() => handleScopeChange('user')}
            >
              User
            </button>
            <button
              className={`settings-scope-tab py-1.5 px-4 rounded-md text-xs font-medium cursor-pointer transition-all duration-150 border-none disabled:opacity-50 disabled:cursor-not-allowed ${
                scope === 'project'
                  ? 'bg-[var(--nim-primary)] text-white shadow-sm'
                  : 'bg-transparent text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
              }`}
              onClick={() => handleScopeChange('project')}
              disabled={!workspacePath}
              title={!workspacePath ? 'Open a project to access project settings' : undefined}
            >
              Project
            </button>
          </div>
          <span className="settings-scope-hint text-[13px] text-[var(--nim-text-muted)]">
            {scope === 'user'
              ? 'These settings apply to all projects'
              : `Settings for ${workspaceName || 'this project'}`}
          </span>
        </div>

        <span className="flex-1" />
        <span className={`settings-save-status text-xs min-w-[60px] ${
          saveStatus === 'saving' ? 'text-[var(--nim-text-muted)]' :
          saveStatus === 'saved' ? 'text-[var(--nim-success)]' :
          saveStatus === 'error' ? 'text-[var(--nim-error)]' :
          'text-[var(--nim-text-faint)]'
        }`}>
          {saveStatus === 'saving' && 'Saving...'}
          {saveStatus === 'saved' && 'Saved'}
          {saveStatus === 'error' && 'Error saving'}
        </span>
      </header>

      <div className="settings-view-body flex flex-1 overflow-hidden relative min-h-0">
        <SettingsSidebar
          selectedCategory={selectedCategory}
          onSelectCategory={setSelectedCategory}
          providerStatus={providerStatus}
          scope={scope}
          // releaseChannel now comes from Jotai atom in SettingsSidebar
        />

        <main className="settings-view-main flex-1 overflow-y-auto p-6 bg-[var(--nim-bg)] relative z-0">
          <div className="settings-panel-container max-w-[800px]">
            {renderPanel()}
          </div>
        </main>
      </div>
    </div>
  );
}
