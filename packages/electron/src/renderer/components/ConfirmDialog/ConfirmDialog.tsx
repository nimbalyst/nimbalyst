import React from 'react';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel
}) => {
  if (!isOpen) return null;

  return (
    <div className="confirm-dialog-overlay nim-overlay" onClick={onCancel}>
      <div
        className="confirm-dialog nim-modal min-w-[400px] max-w-[500px] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="confirm-dialog-title m-0 mb-3 text-lg font-semibold text-nim">{title}</h2>
        <p className="confirm-dialog-message m-0 mb-6 text-sm text-nim-muted leading-relaxed">{message}</p>
        <div className="confirm-dialog-buttons flex gap-3 justify-end">
          <button className="confirm-dialog-button-cancel nim-btn-secondary" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`confirm-dialog-button-confirm ${destructive ? 'nim-btn-danger' : 'nim-btn-primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
