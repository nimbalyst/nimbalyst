import React, { useState, useRef, useEffect } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

interface SquashCommitModalProps {
  isOpen: boolean;
  commitCount: number;
  warningMessage?: string;
  isChecking?: boolean;
  onConfirm: (message: string) => void;
  onCancel: () => void;
}

export function SquashCommitModal({
  isOpen,
  commitCount,
  warningMessage,
  isChecking = false,
  onConfirm,
  onCancel
}: SquashCommitModalProps) {
  const [message, setMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Detect platform for keyboard shortcut hint
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const submitShortcut = isMac ? 'Cmd+Enter' : 'Ctrl+Enter';

  useEffect(() => {
    if (isOpen && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim()) {
      onConfirm(message.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    }
    // Allow Ctrl+Enter or Cmd+Enter to submit
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (message.trim()) {
        onConfirm(message.trim());
      }
    }
  };

  return (
    <div
      className="squash-commit-modal-overlay nim-overlay backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="squash-commit-modal nim-modal w-[90%] max-w-[500px] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit} className="flex flex-col h-full">
          <div className="squash-commit-modal-header flex items-center justify-between px-5 py-4 border-b border-[var(--nim-border)]">
            <h3 className="squash-commit-modal-title m-0 text-base font-semibold text-[var(--nim-text)]">
              Squash {commitCount} Commits
            </h3>
            <button
              type="button"
              className="squash-commit-modal-close nim-btn-icon"
              onClick={onCancel}
              title="Close"
            >
              <MaterialSymbol icon="close" size={20} />
            </button>
          </div>

          {warningMessage && (
            <div className="squash-commit-modal-warning flex items-center gap-2 px-5 py-3 text-sm leading-relaxed bg-[rgba(255,152,0,0.1)] border-b border-[rgba(255,152,0,0.3)] text-[var(--nim-warning)]">
              <MaterialSymbol icon="warning" size={20} className="shrink-0" />
              <span>{warningMessage}</span>
            </div>
          )}

          <div className="squash-commit-modal-body flex-1 p-5 flex flex-col gap-2 overflow-y-auto">
            <label
              htmlFor="commit-message"
              className="squash-commit-modal-label text-sm font-medium text-[var(--nim-text-muted)] block"
            >
              Commit Message
            </label>
            <textarea
              ref={textareaRef}
              id="commit-message"
              className="squash-commit-modal-textarea nim-input font-mono text-sm leading-relaxed resize-y min-h-[120px] p-3 rounded-md"
              placeholder="Enter commit message for squashed commit..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={5}
            />
            <div className="squash-commit-modal-hint text-xs text-[var(--nim-text-faint)] italic">
              Press {submitShortcut} to submit
            </div>
          </div>

          <div className="squash-commit-modal-buttons flex gap-2 px-5 py-4 border-t border-[var(--nim-border)] justify-end">
            <button
              type="button"
              className="squash-commit-modal-button squash-commit-modal-cancel nim-btn-secondary"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="squash-commit-modal-button squash-commit-modal-confirm nim-btn-primary"
              disabled={!message.trim() || isChecking}
            >
              {isChecking ? 'Checking...' : 'Squash Commits'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default SquashCommitModal;
