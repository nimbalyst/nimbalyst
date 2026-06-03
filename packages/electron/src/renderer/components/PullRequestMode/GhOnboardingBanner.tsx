/**
 * GhOnboardingBanner — surfaces the `gh` CLI install/auth state inside the
 * PR review panel. Phase A of issue #307.
 *
 * Rendered as a sticky top bar by `PullRequestMode` when the cached
 * `GhCliStatus` indicates a problem. Self-contained — owns its own status
 * subscription so it can be dropped anywhere the PR review panel needs to
 * warn the user. Dismissal persistence is handled by the parent via the
 * `onDismiss` callback (wired to workspace-settings in Phase F).
 */

import { useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { getGhCliService, type GhCliStatus } from '../../services/RendererGhCliService';

interface GhOnboardingBannerProps {
  /** Initial status — when omitted, the banner fetches on mount. */
  initialStatus?: GhCliStatus;
  /** Called when the user dismisses the banner. */
  onDismiss?: () => void;
  /** When false, the banner stays hidden regardless of status. */
  visible?: boolean;
}

const GH_INSTALL_URL = 'https://cli.github.com/';
const GH_LOGIN_COMMAND = 'gh auth login';

export function GhOnboardingBanner({
  initialStatus,
  onDismiss,
  visible = true,
}: GhOnboardingBannerProps): JSX.Element | null {
  const [status, setStatus] = useState<GhCliStatus | null>(initialStatus ?? null);
  const [isRechecking, setIsRechecking] = useState(false);

  useEffect(() => {
    const service = getGhCliService();

    if (!initialStatus) {
      service.getStatus().then(setStatus).catch(() => {
        setStatus({ installed: false, authed: false });
      });
    }

    const unsubscribe = service.onStatusChanged(setStatus);
    return unsubscribe;
  }, [initialStatus]);

  if (!visible || !status || (status.installed && status.authed)) {
    return null;
  }

  const handleRecheck = async () => {
    setIsRechecking(true);
    try {
      const next = await getGhCliService().refreshStatus();
      setStatus(next);
    } catch {
      // Status broadcast will still arrive if the underlying state changes.
    } finally {
      setIsRechecking(false);
    }
  };

  const handleInstallClick = () => {
    window.electronAPI?.openExternal(GH_INSTALL_URL);
  };

  const handleCopyCommand = () => {
    navigator.clipboard.writeText(GH_LOGIN_COMMAND).catch(() => {
      // Clipboard permission denied — silent; user can still type the command.
    });
  };

  const notInstalled = !status.installed;

  return (
    <div
      className="gh-onboarding-banner flex items-start gap-3 px-4 py-3 border-b border-[var(--nim-border)] bg-nim-tertiary"
      role="status"
    >
      <MaterialSymbol icon="info" size={20} className="text-nim-accent shrink-0 mt-0.5" />

      <div className="flex-1 min-w-0">
        {notInstalled ? (
          <>
            <div className="font-medium text-nim text-sm">GitHub CLI is required</div>
            <div className="text-nim-muted text-xs mt-1">
              PR review uses your <code className="font-mono">gh</code> CLI for all GitHub access.
              Nimbalyst stores no tokens.
            </div>
          </>
        ) : (
          <>
            <div className="font-medium text-nim text-sm">Sign in to GitHub</div>
            <div className="text-nim-muted text-xs mt-1 flex items-center gap-2 flex-wrap">
              Run
              <code className="font-mono bg-nim-bg-primary px-1.5 py-0.5 rounded text-nim">
                {GH_LOGIN_COMMAND}
              </code>
              <button
                type="button"
                className="text-nim-accent hover:underline text-xs"
                onClick={handleCopyCommand}
                title="Copy command"
              >
                Copy
              </button>
              in your terminal. Nimbalyst will pick up your session automatically.
            </div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {notInstalled && (
          <button
            type="button"
            className="nim-button text-xs px-3 py-1.5"
            onClick={handleInstallClick}
          >
            Install gh
          </button>
        )}
        <button
          type="button"
          className="nim-button-secondary text-xs px-3 py-1.5"
          onClick={handleRecheck}
          disabled={isRechecking}
        >
          {isRechecking ? 'Checking…' : 'Recheck'}
        </button>
        {onDismiss && (
          <button
            type="button"
            className="text-nim-muted hover:text-nim p-1"
            onClick={onDismiss}
            title="Dismiss"
            aria-label="Dismiss"
          >
            <MaterialSymbol icon="close" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
