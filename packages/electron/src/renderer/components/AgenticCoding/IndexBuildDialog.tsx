import React from 'react';

export interface IndexBuildDialogProps {
  isOpen: boolean;
  messageCount: number;
  isBuilding: boolean;
  onBuild: () => void;
  onSkip: () => void;
}

export const IndexBuildDialog: React.FC<IndexBuildDialogProps> = ({
  isOpen,
  messageCount,
  isBuilding,
  onBuild,
  onSkip
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="index-build-dialog-overlay nim-overlay"
      onClick={isBuilding ? undefined : onSkip}
    >
      <div
        className="index-build-dialog min-w-[400px] max-w-[500px] rounded-lg p-6 shadow-lg border border-[var(--nim-border)] bg-[var(--nim-bg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="index-build-dialog-title m-0 mb-3 text-lg font-semibold text-[var(--nim-text)]">
          Build Search Index?
        </h2>
        <p className="index-build-dialog-message m-0 mb-6 text-sm leading-relaxed text-[var(--nim-text-muted)] [&_strong]:text-[var(--nim-text)]">
          Your session history contains <strong>{messageCount.toLocaleString()}</strong> messages.
          Building a search index will make searches much faster, but may take a few minutes.
        </p>
        {isBuilding ? (
          <div className="index-build-dialog-progress flex items-center gap-3 p-3 rounded bg-[var(--nim-bg-secondary)] text-sm text-[var(--nim-text-muted)]">
            <div className="index-build-dialog-spinner w-5 h-5 rounded-full border-2 border-[var(--nim-border)] border-t-[var(--nim-primary)] animate-spin" />
            <span>Building index... This may take a few minutes.</span>
          </div>
        ) : (
          <div className="index-build-dialog-buttons flex gap-3 justify-end">
            <button
              className="index-build-dialog-button-skip nim-btn-secondary"
              onClick={onSkip}
            >
              Skip for now
            </button>
            <button
              className="index-build-dialog-button-build nim-btn-primary"
              onClick={onBuild}
            >
              Build Index
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
