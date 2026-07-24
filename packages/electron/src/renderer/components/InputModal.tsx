import React, { useState, useRef, useEffect } from 'react';

interface InputModalProps {
  isOpen: boolean;
  title: string;
  placeholder: string;
  defaultValue?: string;
  suffix?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function InputModal({
  isOpen,
  title,
  placeholder,
  defaultValue = '',
  suffix,
  confirmLabel = 'Create',
  onConfirm,
  onCancel
}: InputModalProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isOpen]);

  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim()) {
      onConfirm(value.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div className="input-modal-overlay nim-overlay" onClick={onCancel}>
      <div
        className="input-modal rounded-lg p-5 w-[400px] max-w-[90%] shadow-[0_10px_25px_rgba(0,0,0,0.2)] bg-[var(--nim-bg)] text-[var(--nim-text)]"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <h3 className="input-modal-title m-0 mb-4 text-base font-semibold text-[var(--nim-text)]">
            {title}
          </h3>
          <div
            className={`input-modal-input-wrapper relative flex items-center mb-4 ${suffix ? 'has-suffix' : ''}`}
          >
            <input
              ref={inputRef}
              type="text"
              className={`input-modal-input nim-input text-sm ${suffix ? 'pr-[120px]' : ''}`}
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            {suffix && (
              <span className="input-modal-suffix absolute right-3 text-sm text-[var(--nim-text-faint)] pointer-events-none select-none">
                {suffix}
              </span>
            )}
          </div>
          <div className="input-modal-buttons flex justify-end gap-2">
            <button
              type="button"
              className="input-modal-button input-modal-cancel nim-btn-secondary px-4 py-1.5 text-sm"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="input-modal-button input-modal-confirm nim-btn-primary px-4 py-1.5 text-sm"
              disabled={!value.trim()}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
