import React, { useCallback, useEffect, useState } from 'react';
import { ProviderConfig } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';

/**
 * Settings panel for the Gemini agent (`antigravity-gemini-agent`), backed by
 * the Antigravity CLI (`agy acp`).
 *
 * Answers the three questions every provider pane answers: is the `agy` CLI
 * installed, are you signed in, and what happens to your files and context.
 */

type InstallStatus = 'checking' | 'installed' | 'signed-out' | 'not-installed';

interface GeminiPanelProps {
  config: ProviderConfig;
  onToggle: (enabled: boolean) => void;
}

const ANTIGRAVITY_URL = 'https://antigravity.google';

export function GeminiPanel({ config, onToggle }: GeminiPanelProps) {
  const [status, setStatus] = useState<InstallStatus>('checking');
  const [installPath, setInstallPath] = useState<string | null>(null);

  const check = useCallback(async () => {
    setStatus('checking');
    try {
      const availability = await window.electronAPI.aiGetHeadlessAgentAvailability?.();
      const gemini = availability?.['antigravity-gemini-agent'];
      setInstallPath(gemini?.executablePath ?? null);
      if (!gemini?.installed) {
        setStatus('not-installed');
      } else if (!gemini.signedIn) {
        setStatus('signed-out');
      } else {
        setStatus('installed');
      }
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
          Google&apos;s Gemini coding agent, run over the Agent Client Protocol via the
          Antigravity CLI (<code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">agy acp</code>).
          Uses your Antigravity account login and supports native tools, web search, and MCP.
        </p>
      </div>

      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
          Antigravity CLI (agy)
        </h4>

        {status === 'checking' && (
          <p className="text-[13px] text-[var(--nim-text-muted)]">Checking for the agy CLI...</p>
        )}

        {status === 'installed' && (
          <div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--nim-success)] shrink-0" />
              <span className="text-[13px] text-[var(--nim-text)]">Installed and signed in</span>
            </div>
            {installPath && (
              <code className="block text-[12px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-3 py-2 rounded mt-2 select-text break-all">
                {installPath}
              </code>
            )}
          </div>
        )}

        {status === 'signed-out' && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2 h-2 rounded-full bg-[var(--nim-warning)] shrink-0" />
              <span className="text-[13px] text-[var(--nim-text)]">Installed, but not signed in</span>
            </div>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              Run{' '}
              <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded select-text">agy acp --login</code>{' '}
              in your terminal to sign in to your Google account, then check again.
            </p>
            <button
              className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-surface)] text-[var(--nim-text)] border border-[var(--nim-border)] hover:bg-[var(--nim-surface-hover)]"
              onClick={() => void check()}
            >
              Check again
            </button>
          </div>
        )}

        {status === 'not-installed' && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="w-2 h-2 rounded-full bg-[var(--nim-warning)] shrink-0" />
              <span className="text-[13px] text-[var(--nim-text)]">Not found</span>
            </div>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              Install the Antigravity CLI (<code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">agy</code>)
              and sign in with{' '}
              <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded select-text">agy acp --login</code>.
              Nimbalyst does not install it for you.
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
          On by default because the agy CLI is installed and signed in. Turning it off here is remembered.
        </p>
      )}

      {config.enabled && (
        <>
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Authentication</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              Gemini uses your Antigravity CLI login. Run{' '}
              <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded select-text">agy acp --login</code>{' '}
              in your terminal to authenticate.
            </p>
            <p className="text-[13px] text-[var(--nim-text-muted)]">
              No API key is required, and Nimbalyst never reads one from your environment.
            </p>
          </div>

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">File tracking</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
              Reports the files it edits through ACP file hooks and tool calls. Deletes and
              renames go through shell commands instead; Nimbalyst watches the project folder
              to catch those, so one can occasionally be attributed to the wrong turn.
            </p>
          </div>

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Context usage</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
              Context window usage and token counts are reported directly by{' '}
              <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">agy acp</code>{' '}
              during each turn.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
