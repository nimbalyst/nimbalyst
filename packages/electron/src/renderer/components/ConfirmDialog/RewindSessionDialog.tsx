import React from 'react';

export interface RewindSessionDialogProps {
  isOpen: boolean;
  /** Messages that will be discarded after the edited one. */
  messageCount: number;
  /** Files changed after the edited message (powers the file-revert option). */
  fileCount: number;
  onChatOnly: () => void;
  onChatAndFiles: () => void;
  onCancel: () => void;
}

/**
 * Confirmation shown when editing a previous message would destructively discard
 * the conversation after it. Offers the Cursor-style choice between resetting
 * only the chat and also reverting the file changes made since.
 */
export const RewindSessionDialog: React.FC<RewindSessionDialogProps> = ({
  isOpen,
  messageCount,
  fileCount,
  onChatOnly,
  onChatAndFiles,
  onCancel,
}) => {
  if (!isOpen) return null;

  const messagePart =
    messageCount > 0
      ? `${messageCount} ${messageCount === 1 ? 'Nachricht' : 'Nachrichten'} nach dieser werden verworfen`
      : 'Die Unterhaltung wird ab hier neu gestartet';
  const filePart =
    fileCount > 0
      ? `, und ${fileCount} ${fileCount === 1 ? 'Datei wurde' : 'Dateien wurden'} seither geändert.`
      : '.';

  return (
    <div className="rewind-session-dialog-overlay nim-overlay" onClick={onCancel}>
      <div
        className="rewind-session-dialog nim-modal min-w-[420px] max-w-[520px] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="rewind-session-dialog-title m-0 mb-3 text-lg font-semibold text-nim">
          Nachricht bearbeiten &amp; zurücksetzen
        </h2>
        <p className="rewind-session-dialog-message m-0 mb-5 text-sm text-nim-muted leading-relaxed">
          {messagePart}
          {filePart} Was soll passieren?
        </p>
        <div className="rewind-session-dialog-buttons flex flex-col gap-2">
          <button
            className="rewind-session-chat-only nim-btn-primary w-full justify-center"
            onClick={onChatOnly}
          >
            Nur Chat zurücksetzen
          </button>
          <button
            className={`rewind-session-chat-and-files w-full justify-center ${fileCount > 0 ? 'nim-btn-danger' : 'nim-btn-secondary'}`}
            onClick={onChatAndFiles}
            disabled={fileCount === 0}
            title={fileCount === 0 ? 'Keine Dateiänderungen nach dieser Nachricht' : undefined}
          >
            Chat + Dateien zurücksetzen
          </button>
          <button
            className="rewind-session-cancel nim-btn-secondary w-full justify-center mt-1"
            onClick={onCancel}
          >
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
};
