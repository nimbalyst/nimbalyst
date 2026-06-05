import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

type AuthMethod = 'chatgpt' | 'api-key';

interface CodexAuthStatus {
  installed: boolean;
  isLoggedIn: boolean;
  authMode: 'apikey' | 'chatgpt' | 'chatgptAuthTokens' | null;
  email: string | null;
  planType: string | null;
  message: string;
  error?: string;
}

export function OpenAICodexPanel({
  config,
  onToggle,
}: OpenAICodexPanelProps) {
  const usageIndicatorEnabled = useAtomValue(codexUsageIndicatorEnabledAtom);
  const setUsageIndicatorEnabled = useSetAtom(setCodexUsageIndicatorEnabledAtom);

  const acpConfigAtom = useMemo(() => getProviderConfigAtom('openai-codex-acp'), []);
  const acpConfig = useAtomValue(acpConfigAtom);
  const setProviderConfig = useSetAtom(setProviderConfigAtom);
  const acpEnabled = acpConfig?.enabled === true;
  const handleAcpToggle = (enabled: boolean) => {
    setProviderConfig({
      providerId: 'openai-codex-acp',
      config: { enabled },
    });
  };

  const [authStatus, setAuthStatus] = useState<CodexAuthStatus | null>(null);
  const [authBusy, setAuthBusy] = useState<'checking' | 'chatgpt' | 'apikey' | 'logout' | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [pendingApiKey, setPendingApiKey] = useState('');
  const [selectedAuthMethod, setSelectedAuthMethod] = useState<AuthMethod>('chatgpt');

  const checkStatus = useCallback(async () => {
    setAuthBusy('checking');
    setAuthError(null);
    try {
      const result = await window.electronAPI.invoke('openai-codex:check-login') as CodexAuthStatus;
      setAuthStatus(result);
      if (result.error) setAuthError(result.error);
      if (result.authMode === 'apikey') setSelectedAuthMethod('api-key');
      else if (result.authMode === 'chatgpt') setSelectedAuthMethod('chatgpt');
    } catch (err: any) {
      setAuthError(err?.message ?? 'Failed to check Codex auth status');
    } finally {
      setAuthBusy(null);
    }
  }, []);

  useEffect(() => {
    if (!config.enabled) return;
    checkStatus();
    const off = window.electronAPI.on('openai-codex:auth-updated', () => {
      checkStatus();
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [config.enabled, checkStatus]);

  const handleChatGptLogin = async () => {
    setAuthBusy('chatgpt');
    setAuthError(null);
    try {
      const result = await window.electronAPI.invoke('openai-codex:login-chatgpt') as { success: boolean; error?: string };
      if (!result.success) {
        setAuthError(result.error ?? 'Login failed');
      }
    } catch (err: any) {
      setAuthError(err?.message ?? 'Login failed');
    } finally {
      setAuthBusy(null);
    }
  };

  const handleApiKeyLogin = async () => {
    if (!pendingApiKey.trim()) {
      setAuthError('Enter an API key first');
      return;
    }
    setAuthBusy('apikey');
    setAuthError(null);
    try {
      const result = await window.electronAPI.invoke('openai-codex:login-apikey', pendingApiKey.trim()) as { success: boolean; error?: string };
      if (!result.success) {
        setAuthError(result.error ?? 'Login failed');
      } else {
        setPendingApiKey('');
        await checkStatus();
      }
    } catch (err: any) {
      setAuthError(err?.message ?? 'Login failed');
    } finally {
      setAuthBusy(null);
    }
  };

  const handleLogout = async () => {
    setAuthBusy('logout');
    setAuthError(null);
    try {
      const result = await window.electronAPI.invoke('openai-codex:logout') as { success: boolean; error?: string };
      if (!result.success) {
        setAuthError(result.error ?? 'Logout failed');
      } else {
        await checkStatus();
      }
    } catch (err: any) {
      setAuthError(err?.message ?? 'Logout failed');
    } finally {
      setAuthBusy(null);
    }
  };

  const isLoggedIn = !!authStatus?.isLoggedIn;
  const planLabel = authStatus?.planType ? ` • ${authStatus.planType}` : '';

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">OpenAI Codex</h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Advanced code generation and completion powered by OpenAI Codex models.
          Provides intelligent code suggestions and automated programming assistance.
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
        <div data-testid="codex-auth-section" className="codex-auth-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Sign In</h4>

          {isLoggedIn ? (
            <div className="status-box-success mb-4 py-3.5 px-4 rounded-lg text-[13px] flex items-center gap-3 justify-between bg-[rgba(16,185,129,0.08)] border border-[rgba(16,185,129,0.2)]">
              <div className="flex items-center gap-3 flex-1">
                <span className="status-box-icon text-xl leading-none shrink-0 text-[var(--nim-success)]">✓</span>
                <div className="status-box-content flex flex-col gap-1 flex-1">
                  <span className="status-box-title font-semibold text-sm text-[var(--nim-text)]">
                    {authStatus?.authMode === 'chatgpt' ? 'Signed in with ChatGPT' : authStatus?.authMode === 'apikey' ? 'Signed in with API key' : 'Signed in'}
                  </span>
                  {(authStatus?.email || authStatus?.planType) && (
                    <span className="status-box-subtitle text-xs text-[var(--nim-text-muted)]">
                      {authStatus?.email ?? ''}{planLabel}
                    </span>
                  )}
                </div>
              </div>
              <div className="status-box-actions flex gap-2 shrink-0">
                <button
                  className="btn-small py-1.5 px-3 rounded text-xs font-medium cursor-pointer transition-all bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  onClick={checkStatus}
                  disabled={authBusy !== null}
                >
                  Refresh
                </button>
                <button
                  className="btn-small py-1.5 px-3 rounded text-xs font-medium cursor-pointer transition-all bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  onClick={handleLogout}
                  disabled={authBusy !== null}
                  data-testid="codex-logout"
                >
                  {authBusy === 'logout' ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="auth-method-row flex gap-2 mb-4">
                <button
                  className={`auth-method-button flex-1 py-2.5 px-4 rounded-md text-[13px] font-medium cursor-pointer transition-all border ${
                    selectedAuthMethod === 'chatgpt'
                      ? 'border-2 border-[var(--nim-primary)] bg-[rgba(59,130,246,0.1)] text-[var(--nim-primary)]'
                      : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-border-focus)]'
                  }`}
                  onClick={() => setSelectedAuthMethod('chatgpt')}
                  data-testid="codex-auth-method-chatgpt"
                >
                  ChatGPT (Recommended)
                </button>
                <button
                  className={`auth-method-button flex-1 py-2.5 px-4 rounded-md text-[13px] font-medium cursor-pointer transition-all border ${
                    selectedAuthMethod === 'api-key'
                      ? 'border-2 border-[var(--nim-primary)] bg-[rgba(59,130,246,0.1)] text-[var(--nim-primary)]'
                      : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-border-focus)]'
                  }`}
                  onClick={() => setSelectedAuthMethod('api-key')}
                  data-testid="codex-auth-method-apikey"
                >
                  API Key
                </button>
              </div>

              {selectedAuthMethod === 'chatgpt' && (
                <div className="mb-4 p-4 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg">
                  <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-3">
                    Authenticate with your ChatGPT Pro, Plus, or Team subscription. No API credits needed.
                  </p>
                  <div className="flex gap-2">
                    <button
                      className="nim-btn-primary flex-1"
                      onClick={handleChatGptLogin}
                      disabled={authBusy !== null}
                      data-testid="codex-login-chatgpt"
                    >
                      {authBusy === 'chatgpt' ? 'Opening browser…' : 'Sign in with ChatGPT'}
                    </button>
                    <button
                      className="nim-btn-secondary"
                      onClick={checkStatus}
                      disabled={authBusy !== null}
                    >
                      Refresh
                    </button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-[var(--nim-text-faint)] mt-2">
                    Opens your default browser. Complete the OpenAI sign-in flow; Nimbalyst updates automatically when you return.
                  </p>
                </div>
              )}

              {selectedAuthMethod === 'api-key' && (
                <div className="mb-4 p-4 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg">
                  <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-3">
                    Use an OpenAI API key. Pay-per-use with API credits — more expensive than the ChatGPT subscription path.
                  </p>
                  <div className="api-key-row flex gap-2 items-center">
                    <input
                      type="password"
                      value={pendingApiKey}
                      onChange={(e) => setPendingApiKey(e.target.value)}
                      onFocus={(e) => e.target.select()}
                      placeholder="sk-..."
                      className="api-key-input flex-1 py-2 px-3 rounded-md bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none font-mono focus:border-[var(--nim-primary)]"
                      data-testid="codex-apikey-input"
                    />
                    <button
                      className="nim-btn-primary"
                      onClick={handleApiKeyLogin}
                      disabled={authBusy !== null || !pendingApiKey.trim()}
                      data-testid="codex-login-apikey"
                    >
                      {authBusy === 'apikey' ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-[var(--nim-text-faint)] mt-2">
                    Stored by Codex in <code>~/.codex/auth.json</code>, not in Nimbalyst settings.
                  </p>
                </div>
              )}
            </>
          )}

          {authError && (
            <p className="text-xs text-[var(--nim-error)] mt-2" data-testid="codex-auth-error">{authError}</p>
          )}
        </div>
      )}
    </div>
  );
}
