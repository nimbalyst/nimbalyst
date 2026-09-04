import React, { useEffect } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { EffortLevel } from '../../utils/modelUtils';
import { EFFORT_LEVELS, DEFAULT_EFFORT_LEVEL, clampEffortLevel, getAvailableEffortLevels } from '../../utils/modelUtils';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';

interface EffortLevelSelectorProps {
  level: EffortLevel;
  onLevelChange: (level: EffortLevel) => void;
  disabled?: boolean;
  disabledTitle?: string;
  /**
   * Model the effort applies to. Levels above the model's ceiling are hidden,
   * so the menu never offers a level the provider would reject (only Codex
   * Astra/Sol/Terra reach Ultra; gpt-5.4/5.5 stop at xHigh).
   */
  modelId?: string;
}

export function EffortLevelSelector({ level, onLevelChange, disabled = false, disabledTitle, modelId }: EffortLevelSelectorProps) {
  const menu = useFloatingMenu({ placement: 'top-start', offsetPx: 4 });
  const { isOpen, setIsOpen } = menu;

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  // Show what will actually run: a session carrying a level the current model
  // cannot accept displays its clamped value rather than the stored one.
  const availableLevels = getAvailableEffortLevels(modelId);
  const effectiveLevel = clampEffortLevel(level, modelId);
  const currentLevel = availableLevels.find((l) => l.key === effectiveLevel) ?? EFFORT_LEVELS.find((l) => l.key === DEFAULT_EFFORT_LEVEL)!;

  return (
    <div className="effort-level-selector relative inline-block">
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        data-testid="effort-level-selector"
        className={`flex items-center gap-1 px-2 py-[3px] rounded-xl text-[11px] font-medium transition-all duration-200 outline-none whitespace-nowrap bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)] border border-[var(--nim-border)] ${
          disabled ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--nim-bg-hover)] hover:border-[var(--nim-primary)]'
        }`}
        onClick={() => {
          if (!disabled) setIsOpen(!isOpen);
        }}
        aria-label={`Effort level: ${currentLevel.label}`}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
      >
        <MaterialSymbol icon="psychology" size={12} />
        <span>{currentLevel.label}</span>
        <MaterialSymbol icon="expand_more" size={14} className={`transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            className="effort-level-selector-menu min-w-[120px] overflow-y-auto rounded-lg p-1 z-[1000] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
          >
            {availableLevels.map((l) => (
              <button
                key={l.key}
                className={`flex items-center justify-between gap-2 px-2 py-1.5 w-full border-none rounded text-xs cursor-pointer transition-[background] duration-150 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] ${
                  l.key === effectiveLevel ? 'bg-[var(--nim-bg-secondary)] text-[var(--nim-primary)]' : ''
                }`}
                onClick={() => {
                  onLevelChange(l.key);
                  setIsOpen(false);
                }}
              >
                <span>{l.label}</span>
                {l.key === effectiveLevel && <MaterialSymbol icon="check" size={14} />}
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
