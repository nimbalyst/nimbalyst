import React, { useState, useRef, useEffect } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { EffortLevel } from '../../utils/modelUtils';
import { EFFORT_LEVELS, DEFAULT_EFFORT_LEVEL } from '../../utils/modelUtils';

interface EffortLevelSelectorProps {
  level: EffortLevel;
  onLevelChange: (level: EffortLevel) => void;
}

export function EffortLevelSelector({ level, onLevelChange }: EffortLevelSelectorProps) {
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

  const currentLevel = EFFORT_LEVELS.find(l => l.key === level) ?? EFFORT_LEVELS.find(l => l.key === DEFAULT_EFFORT_LEVEL)!;

  return (
    <div className="relative inline-block" ref={dropdownRef}>
      <button
        data-testid="effort-level-selector"
        className="flex items-center gap-1 px-2 py-[3px] rounded-xl text-[11px] font-medium cursor-pointer transition-all duration-200 outline-none whitespace-nowrap bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)]"
        onClick={() => setIsOpen(!isOpen)}
        aria-label={`Effort level: ${currentLevel.label}`}
      >
        <MaterialSymbol icon="psychology" size={12} />
        <span>{currentLevel.label}</span>
        <MaterialSymbol icon="expand_more" size={14} className={`transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1 min-w-[120px] rounded-lg p-1 z-[1000] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.15)]">
          {EFFORT_LEVELS.map(l => (
            <button
              key={l.key}
              className={`flex items-center justify-between gap-2 px-2 py-1.5 w-full border-none rounded text-xs cursor-pointer transition-[background] duration-150 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] ${l.key === level ? 'bg-[var(--nim-bg-secondary)] text-[var(--nim-primary)]' : ''}`}
              onClick={() => { onLevelChange(l.key); setIsOpen(false); }}
            >
              <span>{l.label}</span>
              {l.key === level && <MaterialSymbol icon="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
