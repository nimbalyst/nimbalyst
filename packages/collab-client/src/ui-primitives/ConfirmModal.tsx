import React from 'react';
import { createRoot } from 'react-dom/client';

export interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  onSettle: (accepted: boolean) => void;
}

/**
 * In-app replacement for `window.confirm`, which blocks the renderer (and any
 * E2E run driving it) and does not match the app. Always destructive here: the
 * accept button carries the error color. Escape or Cancel cancels; Enter
 * submits from the focused accept button.
 */
export function ConfirmModal({ title, message, confirmLabel, onSettle }: ConfirmModalProps) {
  const onCancel = () => onSettle(false);
  return (
    <div
      className="collab-confirm-overlay nim-overlay"
      onClick={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onCancel(); }
      }}
    >
      <div
        className="collab-confirm-dialog rounded-lg p-5 w-[420px] max-w-[90%] shadow-[0_10px_25px_rgba(0,0,0,0.2)] bg-[var(--nim-bg)] text-[var(--nim-text)]"
        data-testid="collab-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="collab-confirm-title"
        aria-describedby="collab-confirm-message"
        onClick={(event) => event.stopPropagation()}
      >
        <form onSubmit={(event) => { event.preventDefault(); onSettle(true); }}>
          <h3 id="collab-confirm-title" className="collab-confirm-title m-0 mb-2 text-base font-semibold">{title}</h3>
          <p id="collab-confirm-message" className="collab-confirm-message m-0 mb-5 text-sm leading-snug text-[var(--nim-text-muted)] select-text">{message}</p>
          <div className="flex justify-end gap-2">
            <button type="button" className="collab-confirm-cancel nim-btn-secondary px-4 py-1.5 text-sm" onClick={onCancel}>Cancel</button>
            <button
              type="submit"
              autoFocus
              className="collab-confirm-accept px-4 py-1.5 text-sm font-medium rounded-md border-none cursor-pointer text-white bg-[var(--nim-error)] hover:opacity-90"
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Mounts the dialog in its own root on `document.body` and resolves once the
 * user answers. Its own root keeps callers free of dialog state, so the docs-ui
 * eager bundle carries only the lazy import (see `confirmDestructive`).
 */
export function openConfirm(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const settle = (accepted: boolean) => {
      root.unmount();
      container.remove();
      resolve(accepted);
    };
    root.render(<ConfirmModal title={title} message={message} confirmLabel={confirmLabel} onSettle={settle} />);
  });
}
