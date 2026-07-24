import React from 'react';

interface UpdateAvailableToastProps {
  version: string;
  onUpdateNow: () => void;
  onViewReleaseNotes: () => void;
  onRemindLater: () => void;
  onDismiss: () => void;
}

export function UpdateAvailableToast({
  version,
  onUpdateNow,
  onViewReleaseNotes,
  onRemindLater,
  onDismiss,
}: UpdateAvailableToastProps): React.ReactElement {
  return (
    <div
      className="update-toast relative w-[380px] rounded-xl p-4 px-5 border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.3),0_4px_10px_-2px_rgba(0,0,0,0.2)]"
      data-testid="update-available-toast"
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
      <div
        className="update-toast-title text-sm font-semibold text-[var(--nim-text)] mb-1 pr-7"
        data-testid="update-toast-version"
      >
        New Version: Nimbalyst {version}
      </div>
      <div className="update-toast-subtitle text-xs text-[var(--nim-text-muted)] leading-normal mb-4">
        There's a new app update available to download
      </div>

      {/* Action buttons */}
      <div className="update-toast-actions flex gap-2 flex-wrap">
        <button
          className="update-toast-btn update-toast-btn-primary flex-1 py-2 px-3.5 border-none rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 font-[inherit] whitespace-nowrap bg-[var(--nim-primary)] text-white hover:brightness-110"
          onClick={onUpdateNow}
          data-testid="update-now-btn"
        >
          Update Now
        </button>
        <button
          className="update-toast-btn update-toast-btn-secondary py-2 px-3.5 border border-[var(--nim-border)] rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 font-[inherit] whitespace-nowrap bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          onClick={onViewReleaseNotes}
          data-testid="release-notes-btn"
        >
          Release Notes
        </button>
        <button
          className="update-toast-btn update-toast-btn-text py-2 px-3 border-none rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 font-[inherit] whitespace-nowrap bg-transparent text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          onClick={onRemindLater}
          data-testid="remind-later-btn"
        >
          Remind me later
        </button>
      </div>
    </div>
  );
}

export default UpdateAvailableToast;
