import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ProviderConfig } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';
import { OPENCODE_PRESET_MODELS } from '@nimbalyst/runtime/ai/modelConstants';
import type { OpenCodeFileConfig } from '@nimbalyst/runtime/ai/server';

interface OpenCodePanelProps {
  config: ProviderConfig;
  apiKeys: Record<string, string>;
  availableModels: any[];
  loading: boolean;
  onToggle: (enabled: boolean) => void;
  onApiKeyChange: (key: string, value: string) => void;
  onModelToggle: (modelId: string, enabled: boolean) => void;
  onSelectAllModels: (selectAll: boolean) => void;
  onTestConnection: () => Promise<void>;
  onConfigChange: (updates: Partial<ProviderConfig>) => void;
}

type CLIStatus = 'checking' | 'installed' | 'not-installed' | 'installing' | 'install-error';
type LMStudioStatus = 'idle' | 'configuring' | 'success' | 'error';

interface OpenCodeConfigReadResponse {
  success: boolean;
  config?: OpenCodeFileConfig | null;
  configPath?: string;
  error?: string;
}

interface OpenCodeConfigMergeResponse {
  success: boolean;
  config?: OpenCodeFileConfig;
  error?: string;
}

interface OpenCodeLMStudioResponse {
  success: boolean;
  config?: OpenCodeFileConfig;
  modelIds?: string[];
  error?: string;
}

interface ModelOption {
  id: string;
  label: string;
  group: 'preset' | 'lmstudio' | 'custom';
}

function buildModelOptions(config: OpenCodeFileConfig | null): ModelOption[] {
  const presetIds = new Set<string>();
  const presets: ModelOption[] = OPENCODE_PRESET_MODELS.map((m) => {
    const id = `${m.providerID}/${m.modelID}`;
    presetIds.add(id);
    return { id, label: m.name, group: 'preset' };
  });

  const extras: ModelOption[] = [];
  const providers = config?.provider ?? {};
  for (const [providerID, entry] of Object.entries(providers)) {
    const models = entry.models ?? {};
    const providerLabel = entry.name || providerID;
    for (const [modelID, modelEntry] of Object.entries(models)) {
      const id = `${providerID}/${modelID}`;
      if (presetIds.has(id)) continue;
      const baseLabel = modelEntry?.name || modelID;
      extras.push({
        id,
        label: `${baseLabel} (${providerLabel})`,
        group: providerID === 'lmstudio' ? 'lmstudio' : 'custom',
      });
    }
  }

  return [...presets, ...extras];
}

export function OpenCodePanel({
  config,
  apiKeys,
  onToggle,
  onApiKeyChange,
  onTestConnection,
}: OpenCodePanelProps) {
  const [cliStatus, setCLIStatus] = useState<CLIStatus>('checking');
  const [cliVersion, setCLIVersion] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const [openCodeConfig, setOpenCodeConfig] = useState<OpenCodeFileConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [lmStudioStatus, setLmStudioStatus] = useState<LMStudioStatus>('idle');
  const [lmStudioMessage, setLmStudioMessage] = useState<string | null>(null);

  const existingBridgeBaseUrl = openCodeConfig?.provider?.lmstudio?.options?.baseURL as string | undefined;

  // The LM Studio bridge URL field. Default to LM Studio's standard local port;
  // if opencode.json already contains a bridge entry we seed from that exactly
  // once via the ref guard so an async config load doesn't cause a render loop.
  const [lmStudioBaseUrl, setLmStudioBaseUrl] = useState<string>('http://127.0.0.1:1234');
  const seededFromConfig = useRef(false);
  useEffect(() => {
    if (seededFromConfig.current) return;
    if (existingBridgeBaseUrl) {
      setLmStudioBaseUrl(existingBridgeBaseUrl.replace(/\/v\d+\/?$/, ''));
      seededFromConfig.current = true;
    }
  }, [existingBridgeBaseUrl]);

  const checkCLI = useCallback(async () => {
    setCLIStatus('checking');
    try {
      const result = await window.electronAPI.invoke('cli:checkInstallation', 'opencode');
      if (result?.installed) {
        setCLIVersion(result.version || null);
        setCLIStatus('installed');
      } else {
        setCLIStatus('not-installed');
      }
    } catch {
      setCLIStatus('not-installed');
    }
  }, []);

  const refreshOpenCodeConfig = useCallback(async () => {
    try {
      const response = await window.electronAPI.invoke('opencode-config:read') as OpenCodeConfigReadResponse;
      if (response.success) {
        setOpenCodeConfig(response.config ?? null);
        setConfigError(null);
      } else {
        setConfigError(response.error ?? 'Failed to read OpenCode config');
      }
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    checkCLI();
    refreshOpenCodeConfig();
  }, [checkCLI, refreshOpenCodeConfig]);

  const handleInstall = async () => {
    setCLIStatus('installing');
    setInstallError(null);
    try {
      await window.electronAPI.invoke('cli:install', 'opencode', {});
      await checkCLI();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
      setCLIStatus('install-error');
    }
  };

  const persistConfigPatch = async (patch: Partial<OpenCodeFileConfig>): Promise<boolean> => {
    try {
      const response = await window.electronAPI.invoke('opencode-config:merge', patch) as OpenCodeConfigMergeResponse;
      if (response.success && response.config) {
        setOpenCodeConfig(response.config);
        setConfigError(null);
        return true;
      }
      setConfigError(response.error ?? 'Failed to update OpenCode config');
      return false;
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const handleModelChange = async (modelId: string) => {
    if (!modelId) {
      await persistConfigPatch({ model: null as unknown as string });
      return;
    }
    await persistConfigPatch({ model: modelId });
  };

  const handleAutoUpdateToggle = async (enabled: boolean) => {
    // OpenCode's `autoupdate` is true by default. Only write the field when
    // the user opts out -- a missing field means "default behavior".
    await persistConfigPatch({ autoupdate: enabled });
  };

  const handleConnectLMStudio = async () => {
    setLmStudioStatus('configuring');
    setLmStudioMessage(null);
    try {
      const response = await window.electronAPI.invoke('opencode-config:upsert-lmstudio', {
        baseUrl: lmStudioBaseUrl,
        modelIds: [],
        autoDiscoverModels: true,
        displayName: 'LM Studio (local)',
      }) as OpenCodeLMStudioResponse;
      if (response.success && response.config) {
        setOpenCodeConfig(response.config);
        setLmStudioStatus('success');
        const count = response.modelIds?.length ?? 0;
        setLmStudioMessage(`Configured ${count} ${count === 1 ? 'model' : 'models'} from LM Studio.`);
      } else {
        setLmStudioStatus('error');
        setLmStudioMessage(response.error ?? 'Failed to configure LM Studio bridge');
      }
    } catch (err) {
      setLmStudioStatus('error');
      setLmStudioMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDisconnectLMStudio = async () => {
    setLmStudioStatus('configuring');
    try {
      const response = await window.electronAPI.invoke('opencode-config:remove-lmstudio') as OpenCodeConfigMergeResponse;
      if (response.success) {
        setOpenCodeConfig(response.config ?? null);
        setLmStudioStatus('idle');
        setLmStudioMessage(null);
      } else {
        setLmStudioStatus('error');
        setLmStudioMessage(response.error ?? 'Failed to remove LM Studio bridge');
      }
    } catch (err) {
      setLmStudioStatus('error');
      setLmStudioMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const modelOptions = buildModelOptions(openCodeConfig);
  const selectedModel = openCodeConfig?.model ?? '';
  const lmStudioBridgeConfigured = !!openCodeConfig?.provider?.lmstudio;
  const lmStudioBridgeModelCount = openCodeConfig?.provider?.lmstudio?.models
    ? Object.keys(openCodeConfig.provider.lmstudio.models).length
    : 0;
  const autoUpdateOptedOut = openCodeConfig?.autoupdate === false;

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)] flex items-center gap-2">
          OpenCode
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Open source coding agent with multi-model support. Works with Claude, OpenAI, Gemini,
          and local models through a unified interface.
        </p>
      </div>

      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">OpenCode CLI</h4>

        {cliStatus === 'checking' && (
          <p className="text-[13px] text-[var(--nim-text-muted)]">Checking for OpenCode CLI...</p>
        )}

        {cliStatus === 'installed' && (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--nim-success)] shrink-0" />
            <span className="text-[13px] text-[var(--nim-text)]">
              Installed{cliVersion ? ` (${cliVersion})` : ''}
            </span>
          </div>
        )}

        {(cliStatus === 'not-installed' || cliStatus === 'install-error') && (
          <div>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              The OpenCode CLI is required to run the agent.
            </p>
            <button
              className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-primary)] text-white border border-[var(--nim-primary)] hover:opacity-90"
              onClick={handleInstall}
            >
              Install OpenCode CLI
            </button>
            {installError && (
              <div className="text-xs mt-2 text-[var(--nim-error)]">
                {installError}
                <p className="mt-1 text-[var(--nim-text-muted)]">
                  Try running manually: <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">npm i -g opencode-ai</code>
                </p>
              </div>
            )}
          </div>
        )}

        {cliStatus === 'installing' && (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--nim-text-muted)]">Installing OpenCode CLI...</span>
          </div>
        )}

        <p className="text-[13px] text-[var(--nim-text-muted)] mt-3 leading-relaxed">
          See the{' '}
          <a
            href="https://github.com/sst/opencode"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--nim-primary)] hover:underline"
          >
            OpenCode documentation
          </a>
          {' '}for more details.
        </p>
      </div>

      <SettingsToggle
        variant="enable"
        name="Enable OpenCode"
        checked={config.enabled || false}
        onChange={onToggle}
      />

      {config.enabled && (
        <>
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Default model</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              Choose which model OpenCode uses by default. This writes the <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">model</code> field
              of your <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">~/.config/opencode/opencode.json</code>.
            </p>
            <select
              data-testid="opencode-model-select"
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="w-full py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
            >
              <option value="">OpenCode default</option>
              <optgroup label="Hosted">
                {modelOptions.filter((m) => m.group === 'preset').map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </optgroup>
              {modelOptions.some((m) => m.group === 'lmstudio') && (
                <optgroup label="LM Studio (local)">
                  {modelOptions.filter((m) => m.group === 'lmstudio').map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </optgroup>
              )}
              {modelOptions.some((m) => m.group === 'custom') && (
                <optgroup label="Custom providers">
                  {modelOptions.filter((m) => m.group === 'custom').map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </optgroup>
              )}
            </select>
            <p className="text-xs text-[var(--nim-text-muted)] mt-2">
              Picking a hosted model requires the matching API key to be set up in OpenCode's own config.
            </p>
          </div>

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">LM Studio integration</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              Point at a running LM Studio server and Nimbalyst will query <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">/v1/models</code>,
              then write a <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">provider.lmstudio</code> block into your <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">opencode.json</code>.
              You don't need to enable LM Studio as a separate Nimbalyst chat provider.
            </p>
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <input
                data-testid="opencode-lmstudio-base-url"
                type="text"
                value={lmStudioBaseUrl}
                onChange={(e) => { setLmStudioBaseUrl(e.target.value); seededFromConfig.current = true; }}
                onFocus={(e) => e.target.select()}
                placeholder="http://127.0.0.1:1234"
                className="flex-1 min-w-[220px] py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none font-mono focus:border-[var(--nim-primary)]"
              />
              <button
                data-testid="opencode-lmstudio-connect"
                className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-primary)] text-white border border-[var(--nim-primary)] hover:opacity-90 disabled:opacity-60 disabled:cursor-wait"
                onClick={handleConnectLMStudio}
                disabled={lmStudioStatus === 'configuring' || !lmStudioBaseUrl.trim()}
              >
                {lmStudioStatus === 'configuring' ? 'Configuring...' : (lmStudioBridgeConfigured ? 'Refresh' : 'Connect')}
              </button>
              {lmStudioBridgeConfigured && (
                <button
                  data-testid="opencode-lmstudio-disconnect"
                  className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]"
                  onClick={handleDisconnectLMStudio}
                  disabled={lmStudioStatus === 'configuring'}
                >
                  Remove
                </button>
              )}
            </div>
            {lmStudioBridgeConfigured && (
              <p className="text-xs text-[var(--nim-text-muted)]">
                Bridge active with {lmStudioBridgeModelCount} {lmStudioBridgeModelCount === 1 ? 'model' : 'models'}. Select one above to use it as the default.
              </p>
            )}
            {lmStudioMessage && (
              <div className={`text-xs mt-2 ${lmStudioStatus === 'error' ? 'text-[var(--nim-error)]' : 'text-[var(--nim-text-muted)]'}`}>
                {lmStudioMessage}
              </div>
            )}
          </div>

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Updates</h4>
            <SettingsToggle
              variant="enable"
              name="Disable OpenCode auto-update"
              checked={autoUpdateOptedOut}
              onChange={(checked) => handleAutoUpdateToggle(!checked)}
            />
            <p className="text-xs text-[var(--nim-text-muted)] mt-2 leading-relaxed">
              When on, OpenCode will not auto-upgrade itself between sessions. Useful if you want
              version stability while debugging.
            </p>
          </div>

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">API Configuration <span className="text-xs font-normal text-[var(--nim-text-muted)]">(optional)</span></h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              OpenCode reads provider API keys from its own config and from environment variables.
              Setting a key here is optional and is only used by Nimbalyst's connection test.
            </p>
            <div className="api-key-section mt-4">
              <div className="api-key-row flex gap-2 items-center">
                <input
                  type="password"
                  value={apiKeys['opencode'] || ''}
                  onChange={(e) => onApiKeyChange('opencode', e.target.value)}
                  onFocus={(e) => e.target.select()}
                  placeholder="API key (optional)"
                  className="api-key-input flex-1 py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none font-mono focus:border-[var(--nim-primary)]"
                />
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
                   config.testStatus === 'success' ? 'Connected' :
                   config.testStatus === 'error' ? 'Failed' : 'Test'}
                </button>
              </div>
              {config.testMessage && config.testStatus === 'error' && (
                <div className="test-error text-xs mt-2 text-[var(--nim-error)]">{config.testMessage}</div>
              )}
            </div>
          </div>

          {configError && (
            <div className="provider-panel-section py-2 text-xs text-[var(--nim-error)]">
              {configError}
            </div>
          )}
        </>
      )}
    </div>
  );
}
