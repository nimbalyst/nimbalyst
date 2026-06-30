import React, { useState, useRef, useEffect } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { ThinkingMode } from '../../utils/modelUtils';
import { DEFAULT_THINKING_MODE } from '../../utils/modelUtils';

const THINKING_MODE_OPTIONS: Array<{ key: ThinkingMode; label: string }> = [
  { key: 'enabled', label: 'Extended: On' },
  { key: 'disabled', label: 'Extended: Off' },
];

interface ThinkingModeSelectorProps {
  mode: ThinkingMode;
  onModeChange: (mode: ThinkingMode) => void;
  disabled?: boolean;
  disabledTitle?: string;
}

export function ThinkingModeSelector({
  mode,
  onModeChange,
  disabled = false,
  disabledTitle,
}: ThinkingModeSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  const currentMode =
    THINKING_MODE_OPTIONS.find(option => option.key === mode) ??
    THINKING_MODE_OPTIONS.find(option => option.key === DEFAULT_THINKING_MODE)!;

  return (
    <div className="relative inline-block" ref={dropdownRef}>
      <button
        data-testid="thinking-mode-selector"
        className={`thinking-mode-selector flex items-center gap-1 px-2 py-[3px] rounded-xl text-[11px] font-medium transition-all duration-200 outline-none whitespace-nowrap bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)] border border-[var(--nim-border)] ${disabled ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)]'}`}
        onClick={() => {
          if (!disabled) setIsOpen(!isOpen);
        }}
        aria-label={`Extended thinking: ${currentMode.label}`}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
      >
        <MaterialSymbol icon="psychology_alt" size={12} />
        <span>{currentMode.label}</span>
        <MaterialSymbol icon="expand_more" size={14} className={`transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[140px] rounded-lg p-1 z-[1000] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.15)]">
          {THINKING_MODE_OPTIONS.map(option => (
            <button
              key={option.key}
              className={`flex items-center justify-between gap-2 px-2 py-1.5 w-full border-none rounded text-xs cursor-pointer transition-[background] duration-150 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] ${option.key === mode ? 'bg-[var(--nim-bg-secondary)] text-[var(--nim-primary)]' : ''}`}
              onClick={() => {
                onModeChange(option.key);
                setIsOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.key === mode && <MaterialSymbol icon="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
