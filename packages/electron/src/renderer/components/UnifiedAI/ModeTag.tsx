import React from 'react';
import { HelpTooltip } from '../../help';

export type AIMode = 'planning' | 'agent';

interface ModeTagProps {
  mode: AIMode;
  onModeChange: (mode: AIMode) => void;
  disabled?: boolean;
  disabledTitle?: string;
}

/**
 * ModeTag - Compact toggle between Plan and Agent modes
 *
 * Plan mode: Creates plan documents, restricted to markdown files
 * Agent mode: Full tool access, write operations enabled
 */
export function ModeTag({ mode, onModeChange, disabled = false, disabledTitle }: ModeTagProps) {
  const handleToggle = () => {
    if (disabled) return;
    onModeChange(mode === 'planning' ? 'agent' : 'planning');
  };

  return (
    <HelpTooltip testId="plan-mode-toggle">
      <button
        data-testid="plan-mode-toggle"
        className={`mode-tag px-2.5 py-0.5 rounded-xl text-[11px] font-semibold uppercase tracking-wide border-none transition-all duration-200 outline-none ${disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:-translate-y-px hover:shadow-md active:translate-y-0'} ${
          mode === 'planning'
            ? 'mode-tag-plan bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-400 dark:hover:bg-blue-900/60'
            : 'mode-tag-agent bg-orange-100 text-orange-600 hover:bg-orange-200 dark:bg-orange-900/40 dark:text-orange-400 dark:hover:bg-orange-900/60'
        }`}
        onClick={handleToggle}
        disabled={disabled}
        aria-disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        aria-label={mode === 'planning'
          ? 'Plan mode: Creates plan documents (click to enable full agent mode)'
          : 'Agent mode: Full tool access (click to switch to plan mode)'}
        type="button"
      >
        {mode === 'planning' ? 'Plan' : 'Agent'}
      </button>
    </HelpTooltip>
  );
}
