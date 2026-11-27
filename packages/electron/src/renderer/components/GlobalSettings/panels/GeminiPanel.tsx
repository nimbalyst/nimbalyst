import React, { useCallback, useEffect, useState } from 'react';
import { ProviderConfig } from '../../Settings/SettingsView';
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
}

const ANTIGRAVITY_URL = 'https://antigravity.google';

interface GeminiAuthStatus {
  installed: boolean;
  isLoggedIn: boolean;
  email: string | null;
  name: string | null;
  planName: string | null;
  tier: string | null;
  loginInProgress: boolean;
  loginAuthUrl: string | null;
  error?: string;
}

interface GeminiAuthActionResult {
  success: boolean;
  error?: string;
}

function GeminiGoogleAuthSection() {
  const [authStatus, setAuthStatus] = useState<GeminiAuthStatus | null>(null);
  const [authBusy, setAuthBusy] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    setAuthBusy('checking');
    setAuthError(null);
    try {
      const res = (await window.electronAPI.invoke('gemini-auth:status')) as GeminiAuthStatus | null;
      setAuthStatus(res);
      if (res?.error) setAuthError(res.error);
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : 'Failed to check Google sign-in status');
    } finally {
      setAuthBusy(null);
    }
  }, []);

  useEffect(() => {
    void checkStatus();
    const offUpdated = window.electronAPI.on?.('gemini-auth:updated', () => {
      void checkStatus();
    });
    const offDone = window.electronAPI.on?.(
      'gemini-auth:login-completed',
      (payload: { success?: boolean; error?: string | null } | null) => {
        if (payload && payload.success === false && payload.error) {
          setAuthError(payload.error);
        } else {
          setAuthError(null);
        }
        void checkStatus();
      },
    );
    return () => {
      offUpdated?.();
      offDone?.();
    };
  }, [checkStatus]);

  const handleGoogleLogin = async () => {
    setAuthBusy('login');
    setAuthError(null);
    try {
      const res = (await window.electronAPI.invoke('gemini-auth:login')) as GeminiAuthActionResult | null;
      if (!res?.success) setAuthError(res?.error ?? 'Google sign-in failed');
      await checkStatus();
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setAuthBusy(null);
    }
  };

  const handleSwitchAccount = async () => {
    setAuthBusy('switch');
    setAuthError(null);
    try {
      const res = (await window.electronAPI.invoke('gemini-auth:switch-account')) as GeminiAuthActionResult | null;
      if (!res?.success) setAuthError(res?.error ?? 'Account switch failed');
      await checkStatus();
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : 'Account switch failed');
    } finally {
      setAuthBusy(null);
    }
  };

  const handleLogout = async () => {
    setAuthBusy('logout');
    setAuthError(null);
    try {
      const res = (await window.electronAPI.invoke('gemini-auth:logout')) as GeminiAuthActionResult | null;
      if (!res?.success) setAuthError(res?.error ?? 'Sign out failed');
      await checkStatus();
    } catch (err: unknown) {
      setAuthError(err instanceof Error ? err.message : 'Sign out failed');
    } finally {
      setAuthBusy(null);
    }
  };

  const handleCancelLogin = async () => {
    setAuthBusy('cancel');
    try {
      await window.electronAPI.invoke('gemini-auth:cancel-login');
      await checkStatus();
    } finally {
      setAuthBusy(null);
    }
  };

  const handleOpenBrowserAgain = async () => {
    if (authStatus?.loginAuthUrl) {
      await window.electronAPI.invoke('gemini-auth:open-url', authStatus.loginAuthUrl);
    }
  };

  const isLoggedIn = Boolean(authStatus?.isLoggedIn);
  const planLabel = authStatus?.planName ? ` • ${authStatus.planName}` : '';

  return (
    <div
      data-testid="gemini-auth-section"
      className="gemini-auth-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]"
    >
      <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
        Sign In
      </h4>

      {authError && (
        <div
          data-testid="gemini-auth-error"
          className="mb-3 py-2.5 px-3 rounded-md text-xs bg-[rgba(239,68,68,0.08)] border border-[rgba(239,68,68,0.25)] text-red-400"
        >
          {authError}
        </div>
      )}

      {authStatus?.loginInProgress && (
        <div
          data-testid="gemini-auth-in-progress"
          className="mb-3 p-3.5 rounded-lg bg-[rgba(59,130,246,0.08)] border border-[rgba(59,130,246,0.25)] flex items-center justify-between gap-3"
        >
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium text-[var(--nim-text)]">
              Waiting for Google sign-in in your browser…
            </span>
            <span className="text-[11px] text-[var(--nim-text-muted)]">
              Complete the Google OAuth flow; Nimbalyst updates automatically when you return.
            </span>
          </div>
          <div className="flex gap-2 shrink-0">
            {authStatus.loginAuthUrl && (
              <button
                className="btn-small py-1.5 px-3 rounded text-xs font-medium cursor-pointer bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                onClick={handleOpenBrowserAgain}
              >
                Open browser
              </button>
            )}
            <button
              className="btn-small py-1.5 px-3 rounded text-xs font-medium cursor-pointer bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
              onClick={handleCancelLogin}
              disabled={authBusy !== null}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoggedIn ? (
        <div className="status-box-success mb-3 py-3.5 px-4 rounded-lg text-[13px] flex items-center gap-3 justify-between bg-[rgba(16,185,129,0.08)] border border-[rgba(16,185,129,0.2)]">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <span className="status-box-icon text-xl leading-none shrink-0 text-[var(--nim-success)]">
              ✓
            </span>
            <div className="status-box-content flex flex-col gap-1 flex-1 min-w-0">
              <span className="status-box-title font-semibold text-sm text-[var(--nim-text)]">
                Signed in with Google
              </span>
              {(authStatus?.email || authStatus?.planName) && (
                <span className="status-box-subtitle text-xs text-[var(--nim-text-muted)] truncate">
                  {authStatus?.email ?? ''}
                  {planLabel}
                </span>
              )}
            </div>
          </div>
          <div className="status-box-actions flex gap-2 shrink-0">
            <button
              className="btn-small py-1.5 px-3 rounded text-xs font-medium cursor-pointer transition-all bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
              onClick={handleSwitchAccount}
              disabled={authBusy !== null}
              data-testid="gemini-switch-account"
            >
              {authBusy === 'switch' ? 'Switching…' : 'Switch account'}
            </button>
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
              data-testid="gemini-logout"
            >
              {authBusy === 'logout' ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-3 p-4 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg">
          <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-3">
            Sign in with your Google account to use Gemini via Antigravity. No API key needed.
          </p>
          <div className="flex gap-2">
            <button
              className="nim-btn-primary flex-1"
              onClick={handleGoogleLogin}
              disabled={authBusy !== null}
              data-testid="gemini-login-google"
            >
              {authBusy === 'login' ? 'Opening browser…' : 'Sign in with Google'}
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
            Opens your default browser. Complete the Google sign-in flow; Nimbalyst updates
            automatically when you return.
          </p>
        </div>
      )}

      <p className="text-[12px] text-[var(--nim-text-muted)]">
        No API key is required, and Nimbalyst never reads one from your environment.
      </p>
    </div>
  );
}

export function GeminiPanel({ config, onToggle }: GeminiPanelProps) {
  const [status, setStatus] = useState<InstallStatus>('checking');
  const [installPath, setInstallPath] = useState<string | null>(null);

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
          <GeminiGoogleAuthSection />

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
