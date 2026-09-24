import React, { useCallback, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { sessionWakeupsAtom, type SessionWakeupView } from '../../store/atoms/sessions';
import { AttachmentIndicator } from '../UnifiedAI/PromptQueueList';

interface WakeupBannerProps {
  sessionId?: string | null;
  /** Cancels the schedule and returns its prompt to the composer. */
  onEdit?: (wakeup: SessionWakeupView) => void;
}

function formatRelativeFireAt(fireAt: number): string {
  const ms = fireAt - Date.now();
  if (ms <= 0) return 'now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

function formatAbsoluteFireAt(fireAt: number): string {
  return new Date(fireAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Right-aligned timing chip. Kept short because it sits inline before the
 * actions; the long-form explanation moves to the row's title tooltip.
 */
function statusLabel(wakeup: SessionWakeupView): string {
  switch (wakeup.status) {
    case 'pending':
      return `${formatRelativeFireAt(wakeup.fireAt)} · ${formatAbsoluteFireAt(wakeup.fireAt)}`;
    case 'firing':
      return 'Resuming…';
    case 'waiting_for_workspace':
      return 'Waiting for workspace';
    case 'overdue': {
      const hoursAgo = Math.max(0, Math.floor((Date.now() - wakeup.fireAt) / 3_600_000));
      return hoursAgo > 0 ? `Due ${hoursAgo}h ago` : 'Due now';
    }
    default:
      return '';
  }
}

/** Long-form status, shown on hover so the compact chip stays readable. */
function statusTooltip(wakeup: SessionWakeupView): string {
  const parts: string[] = [];
  switch (wakeup.status) {
    case 'pending':
      parts.push(`Scheduled to resume ${formatRelativeFireAt(wakeup.fireAt)} (${formatAbsoluteFireAt(wakeup.fireAt)})`);
      break;
    case 'firing':
      parts.push('Resuming session…');
      break;
    case 'waiting_for_workspace':
      parts.push('Waiting for the workspace window to open');
      break;
    case 'overdue':
      parts.push('Wakeup was due while the app was closed — fire now or cancel?');
      break;
  }
  if (wakeup.origin === 'agent') parts.push('Scheduled by the agent');
  if (wakeup.reason) parts.push(`Reason: ${wakeup.reason}`);
  parts.push(wakeup.prompt);
  return parts.join('\n');
}

interface WakeupRowProps {
  wakeup: SessionWakeupView;
  /** 1-based fire order, shown only when several are scheduled. */
  position: number | null;
  onEdit?: (wakeup: SessionWakeupView) => void;
}

/**
 * One scheduled prompt. Owns its own busy flag so cancelling the second
 * schedule does not disable the buttons on the first.
 */
function WakeupRow({ wakeup, position, onEdit }: WakeupRowProps) {
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  // Re-render every 30s so the relative time stays fresh.
  useEffect(() => {
    if (wakeup.status !== 'pending') return;
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, [wakeup.status]);

  const invoke = useCallback(
    async (channel: 'wakeup:cancel' | 'wakeup:run-now') => {
      if (busy) return;
      setBusy(true);
      try {
        await window.electronAPI.invoke(channel, wakeup.id);
      } catch (error) {
        console.error(`[WakeupBanner] ${channel} failed`, error);
      } finally {
        setBusy(false);
      }
    },
    [wakeup.id, busy],
  );

  const isOverdue = wakeup.status === 'overdue';
  // The agent's self-pacing wakeup is its own instruction, not the user's
  // prompt: it gets a distinct icon and no Edit (editing would hand the
  // agent's text to the composer as if the user had written it).
  const isAgent = wakeup.origin === 'agent';
  // Tint everything off a single accent var so the banner tracks the active
  // theme instead of hardcoded Tailwind palette colors.
  const accent = isOverdue ? 'var(--nim-warning)' : 'var(--nim-primary)';
  // Mirrors .prompt-queue-item so a scheduled prompt and a queued prompt read
  // as the same kind of thing: content left, timing right, actions last.
  const iconButtonClass =
    'shrink-0 w-5 h-5 flex items-center justify-center bg-transparent border-none rounded cursor-pointer p-0 transition-all duration-150 text-[var(--nim-text-muted)] hover:enabled:bg-[var(--nim-bg-hover)] disabled:opacity-50 disabled:cursor-not-allowed';

  return (
      <div
        className="wakeup-banner-prompt flex items-center gap-2 px-2 py-1.5 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[13px]"
        data-testid="wakeup-banner-prompt"
        title={statusTooltip(wakeup)}
      >
        {position === null ? (
          <MaterialSymbol
            icon={isAgent ? 'smart_toy' : 'schedule_send'}
            size={14}
            className="shrink-0 text-[var(--nim-text-muted)]"
          />
        ) : (
          <span
            className="wakeup-banner-position shrink-0 w-[18px] h-[18px] flex items-center justify-center rounded-full text-[11px] font-medium text-[var(--nim-text-muted)] bg-[var(--nim-bg-hover)]"
            title="Fire order"
          >
            {position}
          </span>
        )}
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[var(--nim-text)]">
          {wakeup.prompt}
        </span>

        {/* Same indicator the queue uses, so an attached image reads the same
            whether the prompt is queued or scheduled. */}
        {wakeup.attachments && wakeup.attachments.length > 0 && (
          <AttachmentIndicator attachments={wakeup.attachments} />
        )}

        <span
          className="wakeup-banner-time shrink-0 text-[11px] font-medium whitespace-nowrap"
          style={{ color: accent }}
          data-testid="wakeup-banner-time"
        >
          {statusLabel(wakeup)}
        </span>

        {(wakeup.status === 'pending' || wakeup.status === 'overdue') && (
          <button
            type="button"
            onClick={() => invoke('wakeup:run-now')}
            disabled={busy}
            className={`${iconButtonClass} hover:enabled:text-[var(--nim-primary)]`}
            data-testid="wakeup-banner-run-now"
            title="Fire this wakeup right now"
            aria-label="Fire now"
          >
            <MaterialSymbol icon="bolt" size={14} />
          </button>
        )}
        {onEdit && !isAgent && wakeup.status === 'pending' && (
          <button
            type="button"
            onClick={() => onEdit(wakeup)}
            disabled={busy}
            className={`${iconButtonClass} hover:enabled:text-[var(--nim-text)]`}
            data-testid="wakeup-banner-edit"
            title="Edit this prompt (cancels the schedule and returns it to the composer)"
            aria-label="Edit scheduled prompt"
          >
            &#x270E;
          </button>
        )}
        <button
          type="button"
          onClick={() => invoke('wakeup:cancel')}
          disabled={busy}
          className={`${iconButtonClass} hover:enabled:text-[var(--nim-text)]`}
          data-testid="wakeup-banner-cancel"
          title="Cancel the scheduled wakeup"
          aria-label="Cancel scheduled prompt"
        >
          <MaterialSymbol icon="close" size={14} />
        </button>
      </div>
  );
}

export function WakeupBanner({ sessionId, onEdit }: WakeupBannerProps) {
  const effectiveSessionId = sessionId || '__no_session__';
  const wakeups = useAtomValue(sessionWakeupsAtom(effectiveSessionId));

  if (!sessionId || wakeups.length === 0) return null;

  // Overdue anywhere in the list tints the whole banner, since that is the
  // state that needs attention.
  const accent = wakeups.some((w) => w.status === 'overdue')
    ? 'var(--nim-warning)'
    : 'var(--nim-primary)';

  return (
    <div
      className="wakeup-banner px-3 py-2 border-b"
      style={{
        backgroundColor: `color-mix(in srgb, ${accent} 8%, transparent)`,
        borderBottomColor: `color-mix(in srgb, ${accent} 20%, transparent)`,
      }}
      data-testid="wakeup-banner"
    >
      <div className="wakeup-banner-header flex items-center mb-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide" style={{ color: accent }}>
          {wakeups.length > 1 ? `${wakeups.length} scheduled` : 'Scheduled'}
        </span>
      </div>

      <div className="wakeup-banner-items flex flex-col gap-1 max-h-[30vh] overflow-y-auto">
        {wakeups.map((wakeup, index) => (
          <WakeupRow
            key={wakeup.id}
            wakeup={wakeup}
            position={wakeups.length > 1 ? index + 1 : null}
            onEdit={onEdit}
          />
        ))}
      </div>
    </div>
  );
}
