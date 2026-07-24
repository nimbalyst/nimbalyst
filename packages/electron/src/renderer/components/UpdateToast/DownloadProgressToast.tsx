import React from 'react';

interface DownloadProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

interface DownloadProgressToastProps {
  version: string;
  progress: DownloadProgress | null;
  onCancel: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

function estimateTimeRemaining(bytesPerSecond: number, remaining: number): string {
  if (bytesPerSecond <= 0 || remaining <= 0) {
    return 'Calculating...';
  }

  const secondsRemaining = remaining / bytesPerSecond;

  if (secondsRemaining < 60) {
    return 'Less than 1 minute remaining';
  } else if (secondsRemaining < 3600) {
    const minutes = Math.ceil(secondsRemaining / 60);
    return `About ${minutes} minute${minutes > 1 ? 's' : ''} remaining`;
  } else {
    const hours = Math.floor(secondsRemaining / 3600);
    const minutes = Math.ceil((secondsRemaining % 3600) / 60);
    return `About ${hours}h ${minutes}m remaining`;
  }
}

export function DownloadProgressToast({
  version,
  progress,
  onCancel,
}: DownloadProgressToastProps): React.ReactElement {
  // Handle initial state before first progress event
  const remaining = progress ? progress.total - progress.transferred : 0;
  const timeRemaining = progress ? estimateTimeRemaining(progress.bytesPerSecond, remaining) : 'Starting download...';
  const percent = progress ? Math.round(progress.percent) : 0;

  return (
    <div
      className="update-toast update-toast-download relative w-[340px] rounded-xl p-4 px-5 border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shadow-[0_10px_25px_-5px_rgba(0,0,0,0.3),0_4px_10px_-2px_rgba(0,0,0,0.2)]"
      data-testid="download-progress-toast"
    >
      {/* Header */}
      <div className="update-toast-title text-sm font-semibold text-[var(--nim-text)] mb-3 pr-7">
        Downloading Nimbalyst {version}...
      </div>

      {/* Progress section */}
      <div className="update-toast-progress-section flex items-center gap-3 mb-2">
        {/* App icon placeholder */}
        <div className="update-toast-app-icon w-10 h-10 rounded-lg bg-gradient-to-br from-[var(--nim-primary)] to-[#6366f1] flex items-center justify-center shrink-0 [&>svg]:w-6 [&>svg]:h-6 [&>svg]:text-white">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>

        {/* Progress details */}
        <div className="update-toast-progress-details flex-1">
          <div className="update-toast-progress-text text-xs text-[var(--nim-text)] mb-1.5" data-testid="download-progress-text">
            {progress ? `${formatBytes(progress.transferred)} of ${formatBytes(progress.total)}` : 'Preparing...'}
          </div>
          <div className="update-toast-progress-bar h-1.5 bg-[var(--nim-bg-tertiary)] rounded-sm overflow-hidden">
            <div
              className="update-toast-progress-fill h-full bg-[var(--nim-primary)] rounded-sm transition-[width] duration-300 ease-out"
              style={{ width: `${percent}%` }}
              data-testid="download-progress-fill"
              data-percent={percent}
            />
          </div>
        </div>
      </div>

      {/* Time remaining */}
      <div className="update-toast-time-remaining text-[11px] text-[var(--nim-text-faint)] mb-3" data-testid="download-time-remaining">
        {timeRemaining}
      </div>

      {/* Action buttons */}
      <div className="update-toast-actions flex gap-2 flex-wrap">
        <button
          className="update-toast-btn update-toast-btn-secondary py-2 px-3.5 border border-[var(--nim-border)] rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 font-[inherit] whitespace-nowrap bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          onClick={onCancel}
          data-testid="download-cancel-btn"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default DownloadProgressToast;
