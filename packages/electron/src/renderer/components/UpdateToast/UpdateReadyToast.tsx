import React from 'react';

interface UpdateReadyToastProps {
  version: string;
  waitingForSessions?: boolean;
  onRelaunch: () => void;
  onForceRestart: () => void;
  onDoItLater: () => void;
  onDismiss: () => void;
}

export function UpdateReadyToast({
  version,
  waitingForSessions,
  onRelaunch,
  onForceRestart,
  onDoItLater,
  onDismiss,
}: UpdateReadyToastProps): React.ReactElement {
  if (waitingForSessions) {
    return (
      <div
        className="update-toast relative w-[380px] rounded-xl p-4 px-5 border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.3),0_4px_10px_-2px_rgba(0,0,0,0.2)]"
        data-testid="update-ready-toast"
      >
        {/* Dismiss button */}
        <button
          className="update-toast-dismiss absolute top-3 right-3 w-6 h-6 border-none bg-transparent cursor-pointer rounded flex items-center justify-center p-0 text-[var(--nim-text-faint)] transition-colors duration-200 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text-muted)] [&>svg]:w-3.5 [&>svg]:h-3.5"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss"
          data-testid="update-toast-dismiss"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        {/* Header */}
        <div className="update-toast-title text-sm font-semibold text-[var(--nim-text)] mb-1 pr-7">
          Update ready
        </div>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-4 h-4 border-2 border-[var(--nim-bg-tertiary)] border-t-[var(--nim-primary)] rounded-full animate-spin shrink-0" />
          <div className="update-toast-subtitle text-xs text-[var(--nim-text-muted)] leading-normal">
            Update will apply when all AI sessions are finished
          </div>
        </div>

        {/* Action buttons */}
        <div className="update-toast-actions flex gap-2 flex-wrap">
          <button
            className="update-toast-btn update-toast-btn-primary py-2 px-3.5 border-none rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 font-[inherit] whitespace-nowrap bg-[var(--nim-primary)] text-white hover:brightness-110"
            onClick={onForceRestart}
            data-testid="force-restart-btn"
          >
            Restart Now
          </button>
          <button
            className="update-toast-btn update-toast-btn-secondary py-2 px-3.5 border border-[var(--nim-border)] rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 font-[inherit] whitespace-nowrap bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
            onClick={onDoItLater}
            data-testid="do-it-later-btn"
          >
            Later
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="update-toast relative w-[380px] rounded-xl p-4 px-5 border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.3),0_4px_10px_-2px_rgba(0,0,0,0.2)]"
      data-testid="update-ready-toast"
    >
      {/* Dismiss button */}
      <button
        className="update-toast-dismiss absolute top-3 right-3 w-6 h-6 border-none bg-transparent cursor-pointer rounded flex items-center justify-center p-0 text-[var(--nim-text-faint)] transition-colors duration-200 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text-muted)] [&>svg]:w-3.5 [&>svg]:h-3.5"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss"
        data-testid="update-toast-dismiss"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>

      {/* Header */}
      <div className="update-toast-title text-sm font-semibold text-[var(--nim-text)] mb-1 pr-7">
        Nimbalyst update is ready
      </div>
      <div className="update-toast-subtitle text-xs text-[var(--nim-text-muted)] leading-normal mb-4">
        The app needs to be restarted to apply the update
      </div>

      {/* Action buttons */}
      <div className="update-toast-actions flex gap-2 flex-wrap">
        <button
          className="update-toast-btn update-toast-btn-primary py-2 px-3.5 border-none rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 font-[inherit] whitespace-nowrap bg-[var(--nim-primary)] text-white hover:brightness-110"
          onClick={onRelaunch}
          data-testid="relaunch-btn"
        >
          Relaunch
        </button>
        <button
          className="update-toast-btn update-toast-btn-secondary py-2 px-3.5 border border-[var(--nim-border)] rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 font-[inherit] whitespace-nowrap bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          onClick={onDoItLater}
          data-testid="do-it-later-btn"
        >
          Later
        </button>
      </div>
    </div>
  );
}

export default UpdateReadyToast;
