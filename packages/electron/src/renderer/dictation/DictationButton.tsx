import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { getShortcutDisplay } from '../../shared/KeyboardShortcuts';
import { DICTATION_SHORTCUT } from './dictationShortcut';
import { useDictation } from './useDictation';

/**
 * Mic toggle for a dictation target. Renders nothing when dictation is
 * disabled in Settings.
 */
export function DictationButton({ targetKey, disabled }: { targetKey: string; disabled?: boolean }) {
  const { enabled, recording, status, toggle } = useDictation(targetKey);
  if (!enabled) return null;

  const preparing = status === 'starting' || status === 'preparing';
  const title = recording
    ? 'Stop dictation (Esc discards the unfinished phrase)'
    : `Dictate (click, or hold ${getShortcutDisplay(DICTATION_SHORTCUT)})`;

  return (
    <button
      type="button"
      className={`dictation-button w-9 h-9 shrink-0 flex items-center justify-center rounded-md border border-[var(--nim-border)] cursor-pointer transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
        recording
          ? 'dictation-button-recording bg-[var(--nim-error)] text-white border-transparent'
          : 'bg-[var(--nim-bg)] text-[var(--nim-text-muted)] hover:enabled:bg-[var(--nim-bg-hover)] hover:enabled:text-[var(--nim-text)]'
      } ${preparing ? 'animate-pulse' : ''}`}
      // Keep focus (and the caret) in the input the button dictates into.
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
      disabled={disabled && !recording}
      title={title}
      aria-label={recording ? 'Stop dictation' : 'Start dictation'}
      aria-pressed={recording}
      data-testid="dictation-button"
    >
      <MaterialSymbol icon={recording ? 'stop' : 'mic'} size={18} />
    </button>
  );
}
