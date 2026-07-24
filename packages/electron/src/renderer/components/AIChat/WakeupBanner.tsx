import React, { useCallback, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { sessionWakeupAtom, type SessionWakeupView } from '../../store/atoms/sessions';

interface WakeupBannerProps {
  sessionId?: string | null;
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

function statusLabel(wakeup: SessionWakeupView): string {
  switch (wakeup.status) {
    case 'pending':
      return `Scheduled to resume ${formatRelativeFireAt(wakeup.fireAt)} (${formatAbsoluteFireAt(wakeup.fireAt)})`;
    case 'firing':
      return 'Resuming session…';
    case 'waiting_for_workspace':
      return 'Waiting for the workspace window to open';
    case 'overdue': {
      const hoursAgo = Math.max(0, Math.floor((Date.now() - wakeup.fireAt) / 3_600_000));
      return hoursAgo > 0
        ? `Wakeup was due ${hoursAgo}h ago — fire now or cancel?`
        : 'Wakeup was due while the app was closed — fire now or cancel?';
    }
    default:
      return '';
  }
}

export function WakeupBanner({ sessionId }: WakeupBannerProps) {
  const effectiveSessionId = sessionId || '__no_session__';
  const wakeup = useAtomValue(sessionWakeupAtom(effectiveSessionId));
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);

  // Re-render every 30s so the relative time stays fresh.
  useEffect(() => {
    if (!wakeup || wakeup.status !== 'pending') return;
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, [wakeup]);

  const handleCancel = useCallback(async () => {
    if (!wakeup || busy) return;
    setBusy(true);
    try {
      await window.electronAPI.invoke('wakeup:cancel', wakeup.id);
    } catch (error) {
      console.error('[WakeupBanner] cancel failed', error);
    } finally {
      setBusy(false);
    }
  }, [wakeup, busy]);

  const handleRunNow = useCallback(async () => {
    if (!wakeup || busy) return;
    setBusy(true);
    try {
      await window.electronAPI.invoke('wakeup:run-now', wakeup.id);
    } catch (error) {
      console.error('[WakeupBanner] run-now failed', error);
    } finally {
      setBusy(false);
    }
  }, [wakeup, busy]);

  if (!sessionId) return null;
  if (!wakeup) return null;

  const isOverdue = wakeup.status === 'overdue';
  const containerClass = isOverdue
    ? 'flex items-center justify-between gap-3 px-3 py-2 bg-amber-400/10 border-b border-amber-400/30'
    : 'flex items-center justify-between gap-3 px-3 py-2 bg-blue-400/10 border-b border-blue-400/30';
  const textClass = isOverdue
    ? 'text-xs font-medium text-nim-warning truncate'
    : 'text-xs font-medium text-nim-primary truncate';
  const iconColor = isOverdue ? 'text-nim-warning' : 'text-nim-primary';

  return (
    <div className={containerClass} data-testid="wakeup-banner">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <MaterialSymbol icon="schedule" size={16} className={iconColor} />
        <span className={textClass}>
          {statusLabel(wakeup)}
          {wakeup.reason ? <span className="opacity-80"> — {wakeup.reason}</span> : null}
        </span>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {(wakeup.status === 'pending' || wakeup.status === 'overdue') && (
          <button
            type="button"
            onClick={handleRunNow}
            disabled={busy}
            className="flex items-center gap-1 px-2.5 py-1 bg-transparent border border-current rounded text-[11px] font-medium cursor-pointer transition-all duration-200 hover:enabled:bg-current/10 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="wakeup-banner-run-now"
            title="Fire this wakeup right now"
          >
            <MaterialSymbol icon="bolt" size={14} />
            Fire now
          </button>
        )}
        <button
          type="button"
          onClick={handleCancel}
          disabled={busy}
          className="flex items-center gap-1 px-2.5 py-1 bg-transparent border border-nim-border rounded text-nim-text-muted text-[11px] font-medium cursor-pointer transition-all duration-200 hover:enabled:bg-nim-bg-secondary disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="wakeup-banner-cancel"
          title="Cancel the scheduled wakeup"
        >
          <MaterialSymbol icon="cancel" size={14} />
          Cancel
        </button>
      </div>
    </div>
  );
}
