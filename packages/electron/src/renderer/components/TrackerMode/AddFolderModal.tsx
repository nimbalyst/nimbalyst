import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

interface AddFolderModalProps {
  existingFolderNames: string[];
  onCancel: () => void;
  onConfirm: (name: string) => void;
}

export function AddFolderModal({ existingFolderNames, onCancel, onConfirm }: AddFolderModalProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Folder name is required.');
      return;
    }
    if (existingFolderNames.some((n) => n.toLowerCase() === trimmed.toLowerCase())) {
      setError(`A folder named "${trimmed}" already exists.`);
      return;
    }
    onConfirm(trimmed);
  }, [name, existingFolderNames, onConfirm]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if (e.key === 'Enter') {
        handleSubmit();
      }
    },
    [onCancel, handleSubmit]
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === overlayRef.current) {
        onCancel();
      }
    },
    [onCancel]
  );

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      tabIndex={-1}
    >
      <div
        className="relative flex flex-col bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-xl shadow-2xl w-full max-w-[400px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--nim-border)] shrink-0">
          <h2 className="text-[15px] font-semibold text-[var(--nim-text)]">Add Folder</h2>
          <button
            onClick={onCancel}
            className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-secondary)] cursor-pointer transition-colors"
          >
            <MaterialSymbol icon="close" size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <label className="block text-[12px] font-semibold text-[var(--nim-text-muted)] uppercase tracking-wide mb-1.5">
            Folder name
          </label>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(undefined);
            }}
            placeholder="Folder name"
            className="w-full px-2.5 py-1.5 text-[13px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] transition-colors placeholder:text-[var(--nim-text-faint)]"
          />
          {error && <p className="text-[11px] text-[#ef4444] mt-1">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-[var(--nim-border)] shrink-0">
          <button
            onClick={onCancel}
            className="px-3.5 py-1.5 text-[13px] font-medium text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] bg-transparent hover:bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="px-3.5 py-1.5 text-[13px] font-medium text-white bg-[var(--nim-primary)] hover:opacity-90 rounded-md cursor-pointer transition-opacity"
          >
            Add Folder
          </button>
        </div>
      </div>
    </div>
  );
}
