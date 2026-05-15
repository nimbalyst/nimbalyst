import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ProviderConfig, Model } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';
import {
  codexUsageIndicatorEnabledAtom,
  setCodexUsageIndicatorEnabledAtom,
} from '../../../store/atoms/codexUsageAtoms';
import { getProviderConfigAtom, setProviderConfigAtom } from '../../../store/atoms/appSettings';

interface OpenAICodexPanelProps {
  config: ProviderConfig;
  apiKeys: Record<string, string>;
  availableModels: Model[];
  loading: boolean;
  onToggle: (enabled: boolean) => void;
  onApiKeyChange: (key: string, value: string) => void;
  onModelToggle: (modelId: string, enabled: boolean) => void;
  onSelectAllModels: (selectAll: boolean) => void;
  onTestConnection: () => Promise<void>;
  onConfigChange: (updates: Partial<ProviderConfig>) => void;
}

export function OpenAICodexPanel({
  config,
  apiKeys,
  onToggle,
  onApiKeyChange,
  onTestConnection,
}: OpenAICodexPanelProps) {
  const usageIndicatorEnabled = useAtomValue(codexUsageIndicatorEnabledAtom);
  const setUsageIndicatorEnabled = useSetAtom(setCodexUsageIndicatorEnabledAtom);

  const acpConfig = useAtomValue(getProviderConfigAtom('openai-codex-acp'));
  const setProviderConfig = useSetAtom(setProviderConfigAtom);
  const acpEnabled = acpConfig?.enabled === true;
  const handleAcpToggle = (enabled: boolean) => {
    setProviderConfig({
      providerId: 'openai-codex-acp',
      config: { enabled },
    });
  };

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">OpenAI Codex</h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Advanced code generation and completion powered by OpenAI Codex models.
          Provides intelligent code suggestions and automated programming assistance.
        </p>
      </div>

      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Prerequisites</h4>
        <p className="text-[13px] text-[var(--nim-text-muted)] mb-2 leading-relaxed">
          Before enabling OpenAI Codex, you need to install the Codex CLI and log in with your OpenAI account.
        </p>
        <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
          See the{' '}
          <a
            href="https://github.com/openai/codex"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--nim-primary)] hover:underline"
          >
            OpenAI Codex setup instructions
          </a>
          {' '}for installation and authentication steps.
        </p>
      </div>

      <SettingsToggle
        variant="enable"
        name="Enable OpenAI Codex"
        checked={config.enabled || false}
        onChange={onToggle}
      />

      <SettingsToggle
        variant="enable"
        name="Show Usage Indicator"
        description="Display Codex usage limits in the navigation gutter"
        checked={usageIndicatorEnabled}
        onChange={setUsageIndicatorEnabled}
      />

      {acpEnabled && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
          <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
            ACP Transport <span className="text-xs font-normal text-[var(--nim-text-muted)]">(legacy)</span>
          </h4>
          <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
            <strong>OpenAI Codex (ACP)</strong> is already enabled for this installation, but new Codex
            sessions now use the app-server transport through the main <strong>OpenAI Codex</strong> provider.
          </p>
          <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
            This toggle is hidden by default for new users. Disable ACP here if you no longer need the
            separate legacy provider in the model selector.
          </p>
          <SettingsToggle
            variant="enable"
            name="Enable ACP transport"
            description="Keeps the separate 'OpenAI Codex (ACP)' legacy provider available"
            checked={acpEnabled}
            onChange={handleAcpToggle}
          />
        </div>
      )}

      {config.enabled && (
        <>
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">API Configuration <span className="text-xs font-normal text-[var(--nim-text-muted)]">(optional)</span></h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              By default, Codex uses your CLI login session. Providing an API key is optional and will use
              OpenAI's API pricing, which is more expensive than the Codex account based pricing.
            </p>
            <div className="api-key-section mt-4">
              <div className="api-key-row flex gap-2 items-center">
                <input
                  type="password"
                  value={apiKeys['openai-codex'] || ''}
                  onChange={(e) => onApiKeyChange('openai-codex', e.target.value)}
                  onFocus={(e) => e.target.select()}
                  placeholder="sk-... (optional)"
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
                   config.testStatus === 'success' ? '✓ Connected' :
                   config.testStatus === 'error' ? '✗ Failed' : 'Test'}
                </button>
              </div>
              {config.testMessage && config.testStatus === 'error' && (
                <div className="test-error text-xs mt-2 text-[var(--nim-error)]">{config.testMessage}</div>
              )}
            </div>
          </div>

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Codex Configuration</h4>
            <div className="cli-config-section">
              <p className="text-[13px] text-[var(--nim-text-muted)] mb-3">
                Model selection is handled automatically. No additional configuration required.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
