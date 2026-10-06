import React, { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import { claudeUsageAtom, formatResetTime } from '../../store/atoms/claudeUsageAtoms';
import {
  defaultCustomTime,
  formatFireAtHint,
  hasClaudeUsageReset,
  resolveFireAt,
  tomorrowMorning,
  toDateTimeLocal,
  usageResumeAt,
  type ScheduleLaterChoice,
  type ScheduleLaterMode,
} from './scheduleLater';

interface ScheduleLaterMenuProps {
  disabled?: boolean;
  /** Shown as the tooltip when disabled, so the reason isn't a mystery. */
  disabledReason?: string;
  /** Session provider; the usage-reset option only applies to Claude sessions. */
  provider?: string | null;
  /** Called with the resolved epoch-ms fire time once the user confirms an option. */
  onSchedule: (fireAt: number, choice: ScheduleLaterChoice) => void;
}

const ITEM_CLASS =
  'schedule-later-option flex items-center gap-2 w-full px-2 py-1.5 border-none rounded bg-transparent text-xs text-left cursor-pointer transition-[background] duration-150 text-[var(--nim-text)] hover:enabled:bg-[var(--nim-bg-hover)] focus-visible:bg-[var(--nim-bg-hover)] outline-none disabled:opacity-45 disabled:cursor-not-allowed';

const SECTION_HEADER_CLASS =
  'schedule-later-section-header px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--nim-text-faint)]';

function MenuOption({
  icon,
  label,
  hint,
  onClick,
  disabled,
  title,
  testId,
}: {
  icon: string;
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={ITEM_CLASS}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
    >
      <MaterialSymbol icon={icon} size={14} className="shrink-0 text-[var(--nim-text-muted)]" />
      <span className="flex-1 whitespace-nowrap">{label}</span>
      {hint && <span className="shrink-0 text-[11px] text-[var(--nim-text-faint)] whitespace-nowrap">{hint}</span>}
    </button>
  );
}

export function ScheduleLaterMenu({ disabled = false, disabledReason, provider, onSchedule }: ScheduleLaterMenuProps) {
  const menu = useFloatingMenu({ placement: 'top-end', offsetPx: 6 });
  const { isOpen, setIsOpen } = menu;
  const usage = useAtomValue(claudeUsageAtom);
  const [customTime, setCustomTime] = useState('');
  const [error, setError] = useState<string | null>(null);

  const showUsageReset = hasClaudeUsageReset(provider);
  const resetsAt = usageResumeAt(usage);
  const usageResetAvailable = resetsAt !== null && resolveFireAt({ kind: 'usageReset', resetsAt }) !== null;

  // Fresh each time the menu opens: a stale error greets nobody, and the
  // picker starts on a sensible time instead of an empty placeholder mask.
  useEffect(() => {
    if (isOpen) {
      setCustomTime(defaultCustomTime());
    } else {
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  /**
   * Every path routes through here so an unresolvable time reports itself.
   * A menu that just closes (or does nothing) on an already-passed usage reset
   * is indistinguishable from a successful schedule.
   */
  const confirm = (mode: ScheduleLaterMode, choice: ScheduleLaterChoice, failureMessage: string) => {
    const fireAt = resolveFireAt(mode);
    if (fireAt === null) {
      setError(failureMessage);
      return;
    }
    onSchedule(fireAt, choice);
    setIsOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const options = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button.schedule-later-option:not(:disabled)'),
    );
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
  };

  // Native date pickers draw their calendar glyph from color-scheme, not from
  // our text color; without this it is black-on-dark in dark themes.
  const isDarkTheme = typeof document !== 'undefined' && document.documentElement.classList.contains('dark-theme');
  const now = Date.now();
  const morning = tomorrowMorning(now);

  return (
    <div className="schedule-later-menu relative inline-block">
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        type="button"
        data-testid="schedule-later-trigger"
        className={`schedule-later-trigger w-9 h-9 flex items-center justify-center bg-transparent border rounded-md cursor-pointer transition-all duration-200 shrink-0 hover:enabled:bg-[var(--nim-bg-hover)] hover:enabled:border-[var(--nim-primary)] disabled:opacity-40 disabled:cursor-not-allowed ${
          isOpen
            ? 'border-[var(--nim-primary)] text-[var(--nim-primary)] bg-[var(--nim-bg-hover)]'
            : 'border-[var(--nim-border)] text-[var(--nim-text-muted)]'
        }`}
        onClick={() => {
          if (!disabled) setIsOpen(!isOpen);
        }}
        disabled={disabled}
        title={disabled && disabledReason ? disabledReason : 'Run later'}
        aria-label="Run later"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <MaterialSymbol icon="schedule_send" size={16} />
      </button>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            role="menu"
            onKeyDown={handleKeyDown}
            className="schedule-later-menu-panel w-[248px] rounded-lg p-1 z-[1000] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
          >
            <div className={SECTION_HEADER_CLASS}>Run later</div>
            <MenuOption
              icon="timer"
              label="In 1 hour"
              hint={formatFireAtHint(now + 3_600_000, now)}
              onClick={() => confirm({ kind: 'delay', ms: 3_600_000 }, 'in_1h', 'That delay is too short to schedule.')}
            />
            <MenuOption
              icon="timer"
              label="In 4 hours"
              hint={formatFireAtHint(now + 4 * 3_600_000, now)}
              onClick={() => confirm({ kind: 'delay', ms: 4 * 3_600_000 }, 'in_4h', 'That delay is too short to schedule.')}
            />
            <MenuOption
              icon="wb_twilight"
              label="Tomorrow morning"
              hint={formatFireAtHint(morning, now)}
              onClick={() =>
                confirm({ kind: 'clockTime', isoLocal: toDateTimeLocal(morning) }, 'tomorrow_morning', 'That time has already passed.')
              }
            />
            {showUsageReset && (
              <MenuOption
                icon="autorenew"
                label="When my usage resets"
                hint={resetsAt && usageResetAvailable ? formatResetTime(resetsAt) : undefined}
                testId="schedule-later-usage-reset"
                disabled={!usageResetAvailable}
                title={usageResetAvailable ? undefined : resetsAt ? 'Your usage has already reset' : 'No usage data yet'}
                onClick={() =>
                  resetsAt &&
                  confirm(
                    { kind: 'usageReset', resetsAt },
                    'usage_reset',
                    'Your usage has already reset — send it now instead.',
                  )
                }
              />
            )}

            <div className="my-1 h-px bg-[var(--nim-border)]" role="separator" />

            <div className={SECTION_HEADER_CLASS}>Pick a time</div>
            <form
              className="flex items-center gap-1.5 px-2 pb-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                confirm({ kind: 'clockTime', isoLocal: customTime }, 'custom', 'Pick a time at least 30 seconds from now.');
              }}
            >
              <input
                type="datetime-local"
                data-testid="schedule-later-custom-time"
                value={customTime}
                min={toDateTimeLocal(now)}
                onChange={(e) => {
                  setCustomTime(e.target.value);
                  setError(null);
                }}
                style={{ colorScheme: isDarkTheme ? 'dark' : 'light' }}
                className="flex-1 min-w-0 h-7 px-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-xs text-[var(--nim-text)] outline-none transition-colors duration-150 focus:border-[var(--nim-primary)]"
              />
              <button
                type="submit"
                disabled={!customTime}
                data-testid="schedule-later-custom-submit"
                className="h-7 px-2.5 rounded border-none text-xs font-medium cursor-pointer bg-[var(--nim-primary)] text-white transition-colors duration-150 hover:enabled:bg-[var(--nim-primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Schedule
              </button>
            </form>

            {error && (
              <p
                data-testid="schedule-later-error"
                className="flex items-start gap-1 mx-1 mb-1 px-1.5 py-1 rounded text-[11px] leading-snug text-[var(--nim-error)] bg-[color-mix(in_srgb,var(--nim-error)_10%,transparent)]"
              >
                <MaterialSymbol icon="error" size={12} className="shrink-0 mt-px" />
                <span>{error}</span>
              </p>
            )}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
