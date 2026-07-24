import React, { useEffect, useRef } from 'react';
import { marked } from 'marked';

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

interface ReleaseNotesDialogProps {
  currentVersion: string;
  newVersion: string;
  releaseNotes: string;
  onClose: () => void;
  onUpdate: () => void;
}

export function ReleaseNotesDialog({
  currentVersion,
  newVersion,
  releaseNotes,
  onClose,
  onUpdate,
}: ReleaseNotesDialogProps): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Handle escape key and click outside
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Parse and render markdown release notes
  const renderedReleaseNotes = React.useMemo(() => {
    if (!releaseNotes) {
      return '<p>No release notes available.</p>';
    }
    try {
      return marked.parse(releaseNotes) as string;
    } catch (err) {
      console.error('[ReleaseNotesDialog] Failed to parse release notes:', err);
      return `<p>${releaseNotes}</p>`;
    }
  }, [releaseNotes]);

  return (
    <div
      className="update-dialog-backdrop fixed inset-0 flex items-center justify-center z-[10001] bg-black/50 animate-[fadeIn_0.2s_ease-out]"
      data-testid="release-notes-dialog-backdrop"
    >
      <div
        className="update-dialog relative flex flex-col w-[600px] max-w-[90vw] max-h-[80vh] p-6 rounded-2xl border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] shadow-[0_25px_50px_-12px_rgba(0,0,0,0.4)] animate-[scaleIn_0.2s_ease-out]"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        data-testid="release-notes-dialog"
      >
        {/* Close button */}
        <button
          className="update-dialog-close absolute top-4 right-4 w-7 h-7 border-none bg-transparent cursor-pointer rounded-md flex items-center justify-center p-0 text-[var(--nim-text-faint)] transition-colors duration-200 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text-muted)] [&>svg]:w-4 [&>svg]:h-4"
          onClick={onClose}
          title="Close"
          aria-label="Close"
          data-testid="release-notes-close-btn"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        {/* Header */}
        <div className="update-dialog-header mb-4 pr-8">
          <h2 className="update-dialog-title text-lg font-semibold text-[var(--nim-text)] m-0">A new version of Nimbalyst is available!</h2>
        </div>

        {/* Version comparison */}
        <div className="update-dialog-version-row flex items-center gap-2 mb-5 flex-wrap">
          <span className="update-dialog-version-label text-xs text-[var(--nim-text-muted)]">You are currently on:</span>
          <span className="update-dialog-version-badge text-xs font-medium text-[var(--nim-text)] bg-[var(--nim-bg-tertiary)] py-1 px-2 rounded font-mono" data-testid="current-version-badge">{currentVersion}</span>
          <span className="update-dialog-version-arrow flex items-center text-[var(--nim-text-faint)] [&>svg]:w-4 [&>svg]:h-4">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </span>
          <span className="update-dialog-version-label text-xs text-[var(--nim-text-muted)]">The latest version is:</span>
          <span className="update-dialog-version-badge update-dialog-version-badge-new text-xs font-medium py-1 px-2 rounded font-mono bg-[var(--nim-primary)] text-white" data-testid="new-version-badge">{newVersion}</span>
        </div>

        {/* Release notes */}
        <div className="update-dialog-content flex-1 overflow-y-auto mb-5 pr-2">
          <h3 className="update-dialog-notes-title text-sm font-semibold text-[var(--nim-text)] m-0 mb-3">{newVersion} - Release Notes</h3>
          <div
            className="update-dialog-notes text-[13px] text-[var(--nim-text-muted)] leading-relaxed [&_h1]:text-[var(--nim-text)] [&_h1]:text-base [&_h1]:mt-4 [&_h1]:mb-2 [&_h2]:text-[var(--nim-text)] [&_h2]:text-sm [&_h2]:mt-4 [&_h2]:mb-2 [&_h3]:text-[var(--nim-text)] [&_h3]:text-[13px] [&_h3]:mt-4 [&_h3]:mb-2 [&_p]:my-2 [&_ul]:my-2 [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:pl-5 [&_li]:my-1 [&_code]:bg-[var(--nim-bg-tertiary)] [&_code]:py-0.5 [&_code]:px-1.5 [&_code]:rounded [&_code]:font-mono [&_code]:text-xs [&_pre]:bg-[var(--nim-bg-tertiary)] [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre_code]:bg-transparent [&_pre_code]:p-0"
            data-testid="release-notes-content"
            dangerouslySetInnerHTML={{ __html: renderedReleaseNotes }}
          />
        </div>

        {/* Action buttons */}
        <div className="update-dialog-actions flex gap-3 justify-end">
          <button
            className="update-dialog-btn update-dialog-btn-secondary flex items-center gap-2 py-2.5 px-[18px] border border-[var(--nim-border)] rounded-lg text-sm font-medium cursor-pointer transition-all duration-200 font-[inherit] bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
            onClick={onClose}
            data-testid="release-notes-later-btn"
          >
            Later
          </button>
          <button
            className="update-dialog-btn update-dialog-btn-primary flex items-center gap-2 py-2.5 px-[18px] border-none rounded-lg text-sm font-medium cursor-pointer transition-all duration-200 font-[inherit] bg-[var(--nim-primary)] text-white hover:brightness-110 [&>svg]:w-4 [&>svg]:h-4"
            onClick={onUpdate}
            data-testid="release-notes-update-btn"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            Update to Nimbalyst {newVersion}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ReleaseNotesDialog;
