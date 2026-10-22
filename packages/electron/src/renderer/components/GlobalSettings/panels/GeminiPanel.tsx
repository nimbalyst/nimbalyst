import React, { useCallback, useEffect, useState } from 'react';
import type { ProviderConfig } from '../../Settings/SettingsView';
import { useSetAtom } from 'jotai';
import { useSettingState } from '../../../hooks/useSetting';
import { setAvailableModelsAtom } from '../../../store/atoms/appSettings';
import { GEMINI_MODEL_SETTINGS, isGeminiTierModel, type GeminiModelTier, type GeminiPickerModel } from '../../../../shared/geminiModelSelections';
import { SettingsToggle } from '../SettingsToggle';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';

/**
 * Settings panel for the Gemini agent.
 *
 * Deliberately not `HeadlessCliProviderPanel`: that panel's whole middle is
 * "install this CLI with this command, then run this login command", and
 * neither applies here. Antigravity is a desktop application you download and
 * sign into once, and the language server Nimbalyst talks to is inside its
 * bundle.
 *
 * What this replaces is worth naming, because it is the reason this file
 * exists. While Gemini shipped as an extension, its pane opened with a "Native
 * code grant required" banner asking the user to grant permission to execute
 * native code, listed a `nimbalyst-database-write` catalog permission, and
 * pointed at Installed Extensions to revoke it — first-party code asking the
 * user for consent to run itself. There is no grant here, because there is
 * nothing to grant: this is Nimbalyst's own code in Nimbalyst's own process,
 * held to the same bar as every other built-in provider.
 *
 * So the pane answers the three questions every other provider pane answers:
 * is the tool installed, are you signed in, and what happens to your files.
 */

type InstallStatus = 'checking' | 'installed' | 'not-installed';

interface GeminiPanelProps {
  config: ProviderConfig;
  onToggle: (enabled: boolean) => void;
  availableModels?: GeminiPickerModel[];
}

const ANTIGRAVITY_URL = 'https://antigravity.google';

function GeminiModelChoice({ tier, models }: { tier: GeminiModelTier; models: GeminiPickerModel[] }) {
  const [value, setValue] = useSettingState(GEMINI_MODEL_SETTINGS[tier]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = models.filter(model => !model.unavailable && isGeminiTierModel(tier, model.id));
  const unavailable = !!value && !options.some(model => model.id === value);
  const label = tier[0].toUpperCase() + tier.slice(1);

  return (
    <div className="gemini-model-choice flex flex-col gap-1 mb-3">
      <label htmlFor={`gemini-${tier}-model`} className="text-[13px] text-[var(--nim-text)]">{label}</label>
      <select
        id={`gemini-${tier}-model`}
        value={value}
        disabled={saving}
        className="rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] p-2 text-[13px]"
        onChange={async event => {
          const id = event.target.value;
          setSaving(true);
          setError(null);
          try {
            await setValue(id);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setSaving(false);
          }
        }}
      >
        <option value="">Choose a model</option>
        {unavailable && <option value={value}>{value.replace(/^antigravity-gemini-agent:/, '')} (unavailable)</option>}
        {options.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
      {unavailable && <p className="text-xs text-[var(--nim-warning)]">Unavailable — selection kept. Discover models to check availability.</p>}
      {error && <p role="alert" className="text-xs text-[var(--nim-error)]">{error}</p>}
    </div>
  );
}

export function GeminiPanel({ config, onToggle, availableModels = [] }: GeminiPanelProps) {
  const [status, setStatus] = useState<InstallStatus>('checking');
  const [installPath, setInstallPath] = useState<string | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<GeminiPickerModel[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const updateAvailableModels = useSetAtom(setAvailableModelsAtom);
  const models = discoveredModels ?? availableModels;

  const discover = async () => {
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const response = await window.electronAPI.invoke('ai:discoverGeminiModels');
      if (!response?.success) throw new Error(response?.error || 'Gemini discovery failed');
      setDiscoveredModels(response.models);
      updateAvailableModels({ providerId: 'antigravity-gemini-agent', models: response.models });
      if (response.models.length === 0) setDiscoveryError('No usable Gemini models were reported for this account. Your saved choices are unchanged.');
    } catch (err) {
      setDiscoveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  };

  const check = useCallback(async () => {
    setStatus('checking');
    try {
      const availability = await window.electronAPI.aiGetHeadlessAgentAvailability?.();
      const gemini = availability?.['antigravity-gemini-agent'];
      setInstallPath(gemini?.executablePath ?? null);
      setStatus(gemini?.installed ? 'installed' : 'not-installed');
    } catch {
      setStatus('not-installed');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  return (
    <div className="provider-panel gemini-provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)] flex items-center gap-2">
          Gemini
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Google&apos;s Gemini models, run through the language server that ships inside
          Antigravity. Uses the account you are already signed into there.
        </p>
      </div>

      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
          Antigravity
        </h4>

        {status === 'checking' && (
          <p className="text-[13px] text-[var(--nim-text-muted)]">Looking for Antigravity...</p>
        )}

        {status === 'installed' && (
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--nim-success)] shrink-0" />
              <span className="text-[13px] text-[var(--nim-text)]">Installed</span>
            </div>
            {installPath && (
              <code className="block text-[12px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-3 py-2 rounded mt-2 select-text break-all">
                {installPath}
              </code>
            )}
          </div>
        )}

        {status === 'not-installed' && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2 h-2 rounded-full bg-[var(--nim-warning)] shrink-0" />
              <span className="text-[13px] text-[var(--nim-text)]">Not found</span>
            </div>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              Install Antigravity and sign in once. Nimbalyst does not install it for you,
              and it does not need to stay open — only the language server inside it is used.
            </p>
            <button
              className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-surface)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-surface-hover)]"
              onClick={() => void check()}
            >
              Check again
            </button>
          </div>
        )}

        <p className="text-[13px] text-[var(--nim-text-muted)] mt-3 leading-relaxed">
          See{' '}
          <a
            href={ANTIGRAVITY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--nim-primary)] hover:underline"
          >
            antigravity.google
          </a>
          {' '}for downloads and sign-in.
        </p>
      </div>

      <SettingsToggle
        variant="enable"
        name="Enable Gemini"
        checked={config.enabled || false}
        onChange={onToggle}
      />

      {status === 'installed' && (
        <p className="text-[13px] text-[var(--nim-text-muted)] mt-2 leading-relaxed">
          On by default because Antigravity is installed. Turning it off here is remembered.
        </p>
      )}

      {config.enabled && (
        <>
          <div className="gemini-model-selections provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
            <h4 className="text-base font-semibold mb-3 text-[var(--nim-text)]">Models</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3">Low uses Flash Lite, Medium uses 3.8 Flash, and High uses Pro. Choices are saved separately and are never replaced automatically.</p>
            <button type="button" disabled={discovering} onClick={() => void discover()} className="rounded border border-[var(--nim-border)] bg-[var(--nim-surface)] text-[var(--nim-text)] px-3 py-2 text-sm mb-3">
              {discovering ? 'Discovering...' : 'Discover models'}
            </button>
            <p className="text-xs text-[var(--nim-text-muted)] mb-3">Starts the Antigravity language server using your existing login.</p>
            {(['low', 'medium', 'high'] as const).map(tier => <GeminiModelChoice key={tier} tier={tier} models={models} />)}
            {discoveryError && <p role="alert" className="text-[13px] text-[var(--nim-warning)]">{discoveryError}</p>}
          </div>
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Authentication</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              Sign in inside Antigravity. The language server uses that login, so there is
              nothing to enter here.
            </p>
            <p className="text-[13px] text-[var(--nim-text-muted)]">
              No API key is required, and Nimbalyst never reads one from your environment.
            </p>
          </div>

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">File tracking</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
              Nimbalyst performs this agent&apos;s writes itself, so every edit records the
              file&apos;s exact contents from before it changed and diff review is precise.
              Deletes and renames go through shell commands instead; Nimbalyst watches the
              project folder to catch those, so one can occasionally be attributed to the
              wrong turn.
            </p>
          </div>

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Context usage</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
              Antigravity reports no token counts, so Nimbalyst shows no context meter for
              Gemini rather than a made-up one. Remaining quota is shown in the usage
              indicator instead.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
