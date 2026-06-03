/**
 * Settings panel for the Antigravity Gemini AGENT provider.
 *
 * The inline UsageChip that previously occupied the left column has been
 * REMOVED -- account credits and per-model quota now live on the global
 * AntigravityUsageIndicator floating in the bottom-left navigation gutter,
 * matching the Codex Usage chip pattern. This panel is focused on
 * connection / enable / model selection only.
 *
 * Phase 5: PRE-CONSENT branch. When the backend module is not enabled
 * (first-use case), render an explicit native-code grant banner instead
 * of the usual config UI. The single "Enable provider" button kicks off
 * the host-mediated consent flow that grants:
 *   - the native-code execution capability (utilityProcess.fork)
 *   - the one catalog permission this extension declares
 *     (nimbalyst-database-write)
 * Once the backend module is enabled, fall through to the existing
 * usage / quota / connection / models UI plus the version-gate error
 * display.
 */

import React from 'react';
// Provider class moved into the backend module (dist/agent.js) per Phase 5
// reshape. Model discovery is static, declared in manifest.json. The host
// passes availableModels via props.

interface Model {
  id: string;
  name: string;
  provider: string;
}

interface ProviderConfig {
  enabled?: boolean;
  testStatus?: 'idle' | 'testing' | 'success' | 'error';
  testMessage?: string;
  models?: string[];
  /**
   * True once the user has granted the native-code + catalog-permission
   * bundle for this extension's backend module. False / undefined means
   * the pre-consent banner should be shown instead of the usual UI.
   *
   * Sourced from the extension manifest broker state; the host writes it
   * back after a successful consent grant.
   */
  backendModuleEnabled?: boolean;
}

export interface AntigravityAgentSettingsProps {
  config: ProviderConfig;
  apiKeys?: Record<string, string>;
  availableModels: Model[];
  loading?: boolean;
  onToggle: (enabled: boolean) => void;
  onApiKeyChange?: (key: string, value: string) => void;
  onModelToggle: (modelId: string, enabled: boolean) => void;
  onSelectAllModels: (selectAll: boolean) => void;
  onTestConnection: () => Promise<void>;
  onConfigChange?: (updates: Partial<ProviderConfig>) => void;
  /**
   * Triggers the host-mediated first-use consent flow that grants the
   * native-code execution capability + the nimbalyst-database-write
   * catalog permission, then flips backendModuleEnabled to true.
   *
   * Optional so existing call sites that haven't been migrated to the
   * Phase 5 prop set keep compiling -- the consent button is hidden
   * when this prop is absent (defensive UX rather than silently no-op).
   */
  onEnableBackendModule?: () => Promise<void>;
}

export function AntigravityAgentSettings({
  config,
  availableModels,
  loading,
  onToggle,
  onModelToggle,
  onSelectAllModels,
  onTestConnection,
  onEnableBackendModule,
}: AntigravityAgentSettingsProps): React.ReactElement {
  const enabledModelIds = config.models ?? [];
  const allSelected = availableModels.length > 0
    && availableModels.every((m) => enabledModelIds.includes(m.id));

  // Extension-local error surface for getModels() failures (e.g. version-gate).
  // Mirrors the same pattern in AntigravitySettings (chat panel).
  const [modelsError, setModelsError] = React.useState<string | null>(null);
  const prevEnabledRef = React.useRef<boolean | undefined>(undefined);
  React.useEffect(() => {
    const wasEnabled = prevEnabledRef.current;
    prevEnabledRef.current = config.enabled;

    if (!config.enabled) {
      setModelsError(null);
      return;
    }

    const shouldProbe =
      (wasEnabled === false || wasEnabled === undefined) ||
      (availableModels.length === 0 && !loading);

    if (!shouldProbe) return;

    // Model discovery is now static (manifest.aiAgentProviders[0].models).
    // The host passes availableModels via props; no runtime probe is needed.
    // Clear any stale error state from a previous transition.
    setModelsError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.enabled, availableModels.length, loading]);

  // Auto-tick all models on first enable. Mirrors AntigravitySettings (chat panel).
  // The ref guard prevents multiple disk writes from StrictMode double-invoke +
  // async save broadcast race. See AntigravitySettings for the full rationale.
  const autoSelectFiredRef = React.useRef(false);
  React.useEffect(() => {
    if (
      !autoSelectFiredRef.current
      && config.enabled
      && config.models === undefined
      && availableModels.length > 0
    ) {
      autoSelectFiredRef.current = true;
      onSelectAllModels(true);
    }
  }, [config.enabled, config.models, availableModels.length, onSelectAllModels]);

  // Pre-consent state machine for the Enable-provider button. Disables
  // the button while the grant flow is in-flight and surfaces the
  // failure inline (e.g. user cancelled the consent dialog, or the host
  // rejected the catalog permission).
  const [consentInFlight, setConsentInFlight] = React.useState(false);
  const [consentError, setConsentError] = React.useState<string | null>(null);

  const handleEnableBackendModule = React.useCallback(async () => {
    if (!onEnableBackendModule) return;
    setConsentInFlight(true);
    setConsentError(null);
    try {
      await onEnableBackendModule();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setConsentError(msg);
    } finally {
      setConsentInFlight(false);
    }
  }, [onEnableBackendModule]);

  // PRE-CONSENT BRANCH: backend module not yet enabled. Render the
  // native-code grant banner + single Enable-provider button and bail
  // before the usual config UI. This is the first-use case.
  if (!config.backendModuleEnabled) {
    return (
      <div
        className="provider-panel antigravity-agent-panel antigravity-agent-preconsent flex flex-col"
        data-testid="antigravity-agent-settings"
      >
        <div className="antigravity-main-column flex-1 flex flex-col">
          <div className="provider-panel-header mb-4 pb-4 border-b border-[var(--nim-border)]">
            <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
              Gemini 3.5 Flash (Agent)
            </h3>
            <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
              Agent provider that runs a Nimbalyst-orchestrated tool loop
              over Gemini 3.5 Flash. Auth uses your existing ~/.gemini
              login.
            </p>
          </div>

          <div
            className="antigravity-preconsent-banner p-4 mb-4 rounded-md border border-[var(--nim-warning)] bg-[var(--nim-bg-secondary)]"
            data-testid="antigravity-agent-preconsent-banner"
          >
            <h4 className="text-base font-semibold text-[var(--nim-text)] mb-2">
              Native code grant required
            </h4>
            <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
              This provider ships a backend module that Nimbalyst runs
              in an isolated <code>utilityProcess</code>. Enabling it
              grants the extension permission to execute native code on
              your machine.
            </p>
            <p className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3">
              The extension also requests one catalog permission:
            </p>
            <ul className="text-[13px] leading-relaxed text-[var(--nim-text-muted)] mb-3 ml-5 list-disc">
              <li>
                <code>nimbalyst-database-write</code> - persist agent
                transcripts and tool-call records to the local Nimbalyst
                database.
              </li>
            </ul>
            <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)] mb-4">
              You can revoke either grant later from Settings &gt;
              Extensions. The backend module won&apos;t start until you
              click Enable provider below.
            </p>

            {consentError && (
              <p
                className="text-[13px] text-[var(--nim-error)] mb-3"
                data-testid="antigravity-agent-preconsent-error"
              >
                {consentError}
              </p>
            )}

            {onEnableBackendModule ? (
              <button
                type="button"
                onClick={() => { void handleEnableBackendModule(); }}
                disabled={consentInFlight}
                className="provider-test-button py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-primary)] text-white border border-[var(--nim-primary)] hover:opacity-90 disabled:opacity-50"
                data-testid="antigravity-agent-enable-backend-module"
              >
                {consentInFlight ? 'Requesting consent...' : 'Enable provider'}
              </button>
            ) : (
              <p className="text-[12px] text-[var(--nim-text-muted)] italic">
                Consent flow is unavailable in this host. Update Nimbalyst
                to the latest version to enable the Antigravity backend
                module.
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // POST-CONSENT BRANCH: backend module enabled. Render the existing
  // usage / quota / connection / models UI plus the version-gate error
  // display.
  return (
    <div className="provider-panel antigravity-agent-panel flex flex-col" data-testid="antigravity-agent-settings">
      <div className="antigravity-main-column flex-1 flex flex-col">
        <div className="provider-panel-header mb-4 pb-4 border-b border-[var(--nim-border)]">
          <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
            Gemini 3.5 Flash (Agent)
          </h3>
          <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
            Agent provider that runs a Nimbalyst-orchestrated tool loop over
            Gemini 3.5 Flash. Supports meta-agent mode and the full Nimbalyst
            tool registry. Auth uses your existing ~/.gemini login.
          </p>
        </div>

        <div
          className="provider-panel-section antigravity-test-row py-3 mb-4 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] px-4"
          data-testid="antigravity-agent-connection-test"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <h4 className="text-base font-semibold text-[var(--nim-text)] mb-1">
                Connection
              </h4>
              <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                Test the local Antigravity server. The agent reuses the same
                server as the chat provider.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { void onTestConnection(); }}
              disabled={loading || config.testStatus === 'testing'}
              className={`provider-test-button py-2 px-4 rounded-md text-sm font-medium whitespace-nowrap cursor-pointer transition-all bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)] disabled:opacity-50 ${
                config.testStatus === 'success' ? 'text-[var(--nim-success)] border-[var(--nim-success)]' : ''
              } ${
                config.testStatus === 'error' ? 'text-[var(--nim-error)] border-[var(--nim-error)]' : ''
              }`}
            >
              {config.testStatus === 'testing'
                ? 'Testing...'
                : config.testStatus === 'success'
                ? '✓ Connected'
                : config.testStatus === 'error'
                ? '✗ Failed'
                : 'Test connection'}
            </button>
          </div>
          {config.testMessage && config.testStatus === 'error' && (
            <div className="text-xs mt-2 text-[var(--nim-error)]">
              {config.testMessage}
            </div>
          )}
        </div>

        <div className="provider-panel-section py-3 mb-4 border-b border-[var(--nim-border)] flex items-center justify-between">
          <label htmlFor="agy-agent-enable" className="text-sm font-medium text-[var(--nim-text)]">
            Enable Gemini 3.5 Flash (Agent)
          </label>
          <input
            id="agy-agent-enable"
            type="checkbox"
            checked={config.enabled || false}
            onChange={(e) => onToggle(e.target.checked)}
            className="cursor-pointer"
          />
        </div>

        {config.enabled && (
          <>
            <div
              className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0"
              data-testid="antigravity-agent-models-list"
            >
              <div className="flex items-center justify-between mb-3">
                <h4 className="provider-panel-section-title text-base font-semibold text-[var(--nim-text)]">
                  Models
                </h4>
                {availableModels.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onSelectAllModels(!allSelected)}
                    className="text-[13px] text-[var(--nim-primary)] hover:underline"
                  >
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </button>
                )}
              </div>

              {availableModels.length === 0 ? (
                <>
                  {modelsError && !loading && (
                    <p
                      className="text-[13px] text-[var(--nim-error)] mb-2"
                      data-testid="antigravity-agent-models-error"
                    >
                      {modelsError}
                    </p>
                  )}
                  <p className="text-[13px] text-[var(--nim-text-muted)]">
                    {loading
                      ? 'Loading models...'
                      : 'No models found. Make sure Antigravity is installed and you are signed in, then test the connection.'}
                  </p>
                </>
              ) : (
                <ul className="provider-model-list flex flex-col gap-1">
                  {availableModels.map((model) => (
                    <li key={model.id} className="provider-model-row flex items-center gap-2 py-1">
                      <input
                        type="checkbox"
                        id={`agy-agent-model-${model.id}`}
                        checked={enabledModelIds.includes(model.id)}
                        onChange={(e) => onModelToggle(model.id, e.target.checked)}
                      />
                      <label htmlFor={`agy-agent-model-${model.id}`} className="text-sm text-[var(--nim-text)]">
                        {model.name}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="provider-panel-section py-3">
              <p className="text-[12px] leading-relaxed text-[var(--nim-text-muted)]">
                Default model is <strong>Gemini 3.5 Flash (High)</strong>. The
                agent uses the tool-loop protocol over GetModelResponse - no
                native function calling, no MCP passthrough.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
