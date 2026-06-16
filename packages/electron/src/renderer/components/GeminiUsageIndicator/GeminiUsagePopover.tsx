/**
 * GeminiUsagePopover - Detailed Gemini (Antigravity) usage information popover
 *
 * Shows the primary (most-constrained model) and secondary quota with progress
 * bars and reset times. Degrades to the error message when the snapshot is
 * unavailable (e.g. the language server has not been started yet).
 */

import React, { useEffect, RefObject } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  geminiUsageAtom,
  geminiUsageSessionColorAtom,
  geminiUsageWeeklyColorAtom,
  formatResetTime,
} from '../../store/atoms/geminiUsageAtoms';
import { useSetSetting } from '../../hooks/useSetting';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';

interface GeminiUsagePopoverProps {
  anchorRef: RefObject<HTMLElement>;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

interface UsageSectionProps {
  title: string;
  subtitle: string;
  utilization: number;
  resetsAt: string | null;
  color: 'green' | 'yellow' | 'red' | 'muted';
  windowDurationMs: number;
}

function calculateTimeElapsedPercent(resetsAt: string | null, windowDurationMs: number): number {
  if (!resetsAt) return 0;

  const resetTime = new Date(resetsAt).getTime();
  const now = Date.now();
  const windowStartTime = resetTime - windowDurationMs;
  const elapsedMs = now - windowStartTime;

  const percent = (elapsedMs / windowDurationMs) * 100;
  return Math.max(0, Math.min(100, percent));
}

const UsageSection: React.FC<UsageSectionProps> = ({
  title,
  subtitle,
  utilization,
  resetsAt,
  color,
  windowDurationMs,
}) => {
  const colorClasses: Record<string, { text: string; bar: string }> = {
    green: { text: 'text-green-500', bar: 'bg-green-500' },
    yellow: { text: 'text-yellow-500', bar: 'bg-yellow-500' },
    red: { text: 'text-red-500', bar: 'bg-red-500' },
    muted: { text: 'text-nim-muted', bar: 'bg-nim-muted' },
  };

  const colors = colorClasses[color] || colorClasses.muted;
  const timeElapsedPercent = calculateTimeElapsedPercent(resetsAt, windowDurationMs);
  const isOverPacing = utilization > timeElapsedPercent;

  return (
    <div className="mb-4 last:mb-0">
      <div className="flex justify-between items-baseline mb-1">
        <div>
          <div className="text-[13px] font-semibold text-nim">{title}</div>
          <div className="text-[11px] text-nim-muted">{subtitle}</div>
        </div>
        <div className={`text-[16px] font-semibold ${colors.text}`}>
          {Math.round(utilization)}%
        </div>
      </div>
      <div className="relative h-1.5 bg-nim-tertiary rounded-full overflow-hidden mb-1.5">
        <div
          className={`h-full rounded-full transition-all duration-300 ${colors.bar}`}
          style={{ width: `${Math.min(utilization, 100)}%` }}
        />
        <div
          className={`absolute top-0 h-full w-0.5 transition-all duration-300 ${isOverPacing ? 'bg-red-400' : 'bg-nim-text-muted'}`}
          style={{ left: `${timeElapsedPercent}%` }}
          title={`${Math.round(timeElapsedPercent)}% of window elapsed`}
        />
      </div>
      <div className="flex items-center gap-1 text-[11px] text-nim-muted">
        <MaterialSymbol icon="schedule" size={12} className="opacity-70" />
        <span>Resets in {formatResetTime(resetsAt)}</span>
      </div>
    </div>
  );
};

export const GeminiUsagePopover: React.FC<GeminiUsagePopoverProps> = ({
  anchorRef,
  onClose,
  onRefresh,
}) => {
  const usage = useAtomValue(geminiUsageAtom);
  const sessionColor = useAtomValue(geminiUsageSessionColorAtom);
  const weeklyColor = useAtomValue(geminiUsageWeeklyColorAtom);
  const setUsageIndicatorEnabled = useSetSetting('ai.showGeminiUsageIndicator');
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const menu = useFloatingMenu({
    placement: 'right-end',
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

  // Set the anchor element as the position reference
  useEffect(() => {
    if (anchorRef.current) {
      menu.refs.setReference(anchorRef.current);
    }
  }, [anchorRef, menu.refs]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  if (!usage) {
    return null;
  }

  const limitsAvailable = usage.limitsAvailable ?? true;

  // Per-model quota windows don't expose a fixed duration, so use the same
  // session/weekly windows the Codex chip uses for the pacing marker math.
  const sessionWindowMs = 5 * 60 * 60 * 1000; // 5 hours
  const weeklyWindowMs = 7 * 24 * 60 * 60 * 1000; // 7 days

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="w-60 bg-nim-secondary border border-nim rounded-lg shadow-lg z-50 overflow-y-auto"
        data-testid="gemini-usage-popover"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-nim">
          <div className="flex items-center gap-2">
            {/* Gemini glyph */}
            <span className="text-blue-500 flex items-center">
              <MaterialSymbol icon="gemini" size={18} />
            </span>
            <span className="text-[14px] font-semibold text-nim">Gemini Usage</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="p-1 rounded hover:bg-nim-tertiary text-nim-muted hover:text-nim transition-colors disabled:opacity-50"
              aria-label="Refresh usage"
            >
              <MaterialSymbol icon="refresh" size={14} className={isRefreshing ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-nim-tertiary text-nim-muted hover:text-nim transition-colors"
              aria-label="Close"
            >
              <MaterialSymbol icon="close" size={14} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="px-4 py-3">
          {usage.notStarted ? (
            <div className="text-[13px] text-nim-muted">
              {usage.error || 'Gemini usage will appear after your first request.'}
            </div>
          ) : usage.error ? (
            <div className="text-[13px] text-nim-error">{usage.error}</div>
          ) : (
            <>
              {!limitsAvailable && (
                <div className="mb-3 text-[12px] text-nim-muted">
                  Usage detected, but Gemini limits are unavailable in recent session data.
                </div>
              )}
              <UsageSection
                title="Session"
                subtitle="Most-constrained model"
                utilization={usage.fiveHour.utilization}
                resetsAt={usage.fiveHour.resetsAt}
                color={sessionColor as 'green' | 'yellow' | 'red' | 'muted'}
                windowDurationMs={sessionWindowMs}
              />
              <UsageSection
                title="Secondary"
                subtitle="Next-most-constrained model"
                utilization={usage.sevenDay.utilization}
                resetsAt={usage.sevenDay.resetsAt}
                color={weeklyColor as 'green' | 'yellow' | 'red' | 'muted'}
                windowDurationMs={weeklyWindowMs}
              />
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-nim flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            {usage.lastUpdated && (
              <span className="text-[10px] text-nim-faint">
                Updated {formatLastUpdated(usage.lastUpdated)}
              </span>
            )}
            <button
              onClick={() => {
                setUsageIndicatorEnabled(false);
                onClose();
              }}
              className="text-[11px] text-nim-muted hover:text-nim transition-colors"
            >
              Disable
            </button>
          </div>
          <button
            onClick={() => window.electronAPI.openExternal('https://status.cloud.google.com/')}
            className="flex items-center gap-1 text-[11px] text-nim-muted hover:text-nim transition-colors"
          >
            <MaterialSymbol icon="open_in_new" size={12} />
            <span>Google Cloud Status</span>
          </button>
        </div>
      </div>
    </FloatingPortal>
  );
};

function formatLastUpdated(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);

  if (diffSeconds < 60) {
    return 'just now';
  }
  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
}
