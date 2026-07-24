import React, { useCallback } from 'react';
import { useAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { UpdateAvailableToast } from './UpdateAvailableToast';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';
import { DownloadProgressToast } from './DownloadProgressToast';
import { UpdateReadyToast } from './UpdateReadyToast';
import { updateStateAtom } from '../../store/atoms/updateState';

// Re-export types from atom file for backwards compatibility
export type { UpdateState, UpdateInfo, DownloadProgress } from '../../store/atoms/updateState';

export function UpdateToast(): React.ReactElement | null {
  const [updateState, setUpdateState] = useAtom(updateStateAtom);
  const { state, updateInfo, currentVersion, downloadProgress, errorMessage } = updateState;
  const posthog = usePostHog();

  // Action handlers
  const handleUpdateNow = useCallback(() => {
    console.log('[UpdateToast] Update now clicked');
    posthog?.capture('update_toast_action', {
      action: 'download_clicked',
      new_version: updateInfo?.version || 'unknown'
    });
    setUpdateState((prev) => ({ ...prev, state: 'downloading' }));
    window.electronAPI.send('update-toast:download');
  }, [posthog, updateInfo?.version, setUpdateState]);

  const handleViewReleaseNotes = useCallback(() => {
    console.log('[UpdateToast] View release notes clicked');
    posthog?.capture('update_toast_action', {
      action: 'release_notes_clicked',
      new_version: updateInfo?.version || 'unknown'
    });
    setUpdateState((prev) => ({ ...prev, state: 'viewing-notes' }));
  }, [posthog, updateInfo?.version, setUpdateState]);

  const handleRemindLater = useCallback(async () => {
    console.log('[UpdateToast] Remind later clicked');
    posthog?.capture('update_toast_action', {
      action: 'remind_later_clicked',
      new_version: updateInfo?.version || 'unknown'
    });
    if (updateInfo) {
      try {
        await window.electronAPI.invoke('update:set-reminder-suppression', updateInfo.version);
      } catch (error) {
        console.error('[UpdateToast] Failed to set reminder suppression:', error);
      }
    }
    setUpdateState((prev) => ({ ...prev, state: 'idle', updateInfo: null }));
  }, [posthog, updateInfo, setUpdateState]);

  const handleDismiss = useCallback(() => {
    console.log('[UpdateToast] Dismiss clicked');
    setUpdateState((prev) => ({ ...prev, state: 'idle', updateInfo: null }));
  }, [setUpdateState]);

  const handleCloseReleaseNotes = useCallback(() => {
    console.log('[UpdateToast] Close release notes clicked');
    setUpdateState((prev) => ({ ...prev, state: 'available' }));
  }, [setUpdateState]);

  const handleUpdateFromNotes = useCallback(() => {
    console.log('[UpdateToast] Update from release notes clicked');
    setUpdateState((prev) => ({ ...prev, state: 'downloading' }));
    window.electronAPI.send('update-toast:download');
  }, [setUpdateState]);

  const handleCancelDownload = useCallback(() => {
    console.log('[UpdateToast] Cancel download clicked');
    // Note: electron-updater doesn't support canceling downloads directly
    // We'll just hide the toast and let the download continue in the background
    setUpdateState((prev) => ({ ...prev, state: 'idle', updateInfo: null, downloadProgress: null }));
  }, [setUpdateState]);

  const handleRelaunch = useCallback(async () => {
    console.log('[UpdateToast] Relaunch clicked');
    try {
      const result = await window.electronAPI.invoke('update:has-active-sessions');
      if (result.hasActiveSessions) {
        console.log('[UpdateToast] Active AI sessions detected, deferring install');
        posthog?.capture('update_toast_action', {
          action: 'install_deferred',
          reason: 'active_ai_sessions',
          new_version: updateInfo?.version || 'unknown'
        });
        setUpdateState((prev) => ({ ...prev, state: 'waiting-for-sessions' }));
        window.electronAPI.send('update-toast:install-when-idle');
        return;
      }
    } catch (error) {
      console.error('[UpdateToast] Failed to check active sessions, proceeding with install:', error);
    }
    window.electronAPI.send('update-toast:install');
  }, [posthog, updateInfo?.version, setUpdateState]);

  const handleForceRestart = useCallback(() => {
    console.log('[UpdateToast] Force restart clicked');
    posthog?.capture('update_toast_action', {
      action: 'force_restart_clicked',
      new_version: updateInfo?.version || 'unknown'
    });
    window.electronAPI.send('update-toast:install');
  }, [posthog, updateInfo?.version]);

  const handleDoItLater = useCallback(() => {
    console.log('[UpdateToast] Do it later clicked');
    setUpdateState((prev) => ({ ...prev, state: 'idle', updateInfo: null, downloadProgress: null }));
  }, [setUpdateState]);

  // Don't render anything if idle
  if (state === 'idle') {
    return null;
  }

  return (
    <>
      {/* Toast container for all toast states */}
      {(state === 'checking' || state === 'up-to-date' || state === 'available' || state === 'downloading' || state === 'ready' || state === 'waiting-for-sessions' || state === 'error') && (
        <div
          className="update-toast-container fixed bottom-5 right-5 z-[10000] animate-[slideUp_0.3s_ease-out]"
          data-testid="update-toast-container"
          data-state={state}
        >
          {state === 'checking' && (
            <div
              className="update-toast update-toast-checking flex items-center gap-3 w-auto min-w-[220px] relative rounded-xl p-4 px-5 border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.3),0_4px_10px_-2px_rgba(0,0,0,0.2)]"
              data-testid="update-checking-toast"
            >
              <div className="update-toast-spinner w-5 h-5 border-2 border-[var(--nim-bg-tertiary)] border-t-[var(--nim-primary)] rounded-full animate-spin shrink-0" />
              <div className="update-toast-title text-sm font-semibold text-[var(--nim-text)] mb-0 pr-0">Checking for updates...</div>
            </div>
          )}

          {state === 'up-to-date' && (
            <div
              className="update-toast update-toast-up-to-date flex flex-col items-start w-auto min-w-[280px] relative rounded-xl p-4 px-5 border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.3),0_4px_10px_-2px_rgba(0,0,0,0.2)]"
              data-testid="update-up-to-date-toast"
            >
              <button
                className="update-toast-dismiss absolute top-3 right-3 w-6 h-6 border-none bg-transparent cursor-pointer rounded flex items-center justify-center p-0 text-[var(--nim-text-faint)] transition-colors duration-200 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text-muted)] [&>svg]:w-3.5 [&>svg]:h-3.5"
                onClick={handleDismiss}
                title="Dismiss"
                aria-label="Dismiss"
                data-testid="update-toast-dismiss"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
              <div className="update-toast-check-icon w-8 h-8 rounded-full bg-[var(--nim-success)] flex items-center justify-center mb-3 [&>svg]:w-[18px] [&>svg]:h-[18px] [&>svg]:text-white">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </div>
              <div className="update-toast-title text-sm font-semibold text-[var(--nim-text)] mb-1 pr-7">You're up to date!</div>
              <div className="update-toast-subtitle text-xs text-[var(--nim-text-muted)] leading-normal mb-0">Nimbalyst {currentVersion} is the latest version.</div>
            </div>
          )}

          {state === 'available' && updateInfo && (
            <UpdateAvailableToast
              version={updateInfo.version}
              onUpdateNow={handleUpdateNow}
              onViewReleaseNotes={handleViewReleaseNotes}
              onRemindLater={handleRemindLater}
              onDismiss={handleDismiss}
            />
          )}

          {state === 'downloading' && updateInfo && (
            <DownloadProgressToast
              version={updateInfo.version}
              progress={downloadProgress}
              onCancel={handleCancelDownload}
            />
          )}

          {(state === 'ready' || state === 'waiting-for-sessions') && updateInfo && (
            <UpdateReadyToast
              version={updateInfo.version}
              waitingForSessions={state === 'waiting-for-sessions'}
              onRelaunch={handleRelaunch}
              onForceRestart={handleForceRestart}
              onDoItLater={handleDoItLater}
              onDismiss={handleDismiss}
            />
          )}

          {state === 'error' && (
            <div
              className="update-toast update-toast-error relative w-[380px] rounded-xl p-4 px-5 border border-[var(--nim-error)] bg-[var(--nim-bg-secondary)] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.3),0_4px_10px_-2px_rgba(0,0,0,0.2)]"
              data-testid="update-error-toast"
            >
              <button
                className="update-toast-dismiss absolute top-3 right-3 w-6 h-6 border-none bg-transparent cursor-pointer rounded flex items-center justify-center p-0 text-[var(--nim-text-faint)] transition-colors duration-200 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text-muted)] [&>svg]:w-3.5 [&>svg]:h-3.5"
                onClick={handleDismiss}
                title="Dismiss"
                aria-label="Dismiss"
                data-testid="update-toast-dismiss"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
              <div className="update-toast-title text-sm font-semibold text-[var(--nim-error)] mb-1 pr-7">Update Error</div>
              <div className="update-toast-subtitle text-xs text-[var(--nim-text-muted)] leading-normal mb-1" data-testid="error-message">{errorMessage}</div>
              <div className="text-xs text-[var(--nim-text-muted)] leading-normal mb-4">
                You can <a
                  href="https://nimbalyst.com/download"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--nim-primary)] hover:underline cursor-pointer"
                  data-testid="manual-download-link"
                >download the latest version manually</a>.
              </div>
              <div className="update-toast-actions flex gap-2 flex-wrap">
                <button
                  className="update-toast-btn update-toast-btn-secondary py-2 px-3.5 border border-[var(--nim-border)] rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 font-[inherit] whitespace-nowrap bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                  onClick={handleDismiss}
                  data-testid="error-dismiss-btn"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Release notes dialog (modal) */}
      {state === 'viewing-notes' && updateInfo && (
        <ReleaseNotesDialog
          currentVersion={currentVersion}
          newVersion={updateInfo.version}
          releaseNotes={updateInfo.releaseNotes || ''}
          onClose={handleCloseReleaseNotes}
          onUpdate={handleUpdateFromNotes}
        />
      )}
    </>
  );
}

export default UpdateToast;
