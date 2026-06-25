/**
 * FuguUsagePopover - Detailed Sakana Fugu usage information.
 */

import React, { useEffect, RefObject } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  fuguUsageAtom,
  fuguUsageSessionColorAtom,
  fuguUsageWeeklyColorAtom,
  formatResetTime,
} from '../../store/atoms/fuguUsageAtoms';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';
import { useSetSetting } from '../../hooks/useSetting';

interface FuguUsagePopoverProps {
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
    green: { text: 'text-cyan-400', bar: 'bg-cyan-400' },
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

export const FuguUsagePopover: React.FC<FuguUsagePopoverProps> = ({
  anchorRef,
  onClose,
  onRefresh,
}) => {
  const usage = useAtomValue(fuguUsageAtom);
  const sessionColor = useAtomValue(fuguUsageSessionColorAtom);
  const weeklyColor = useAtomValue(fuguUsageWeeklyColorAtom);
  const setUsageIndicatorEnabled = useSetSetting('ai.showFuguUsageIndicator');
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const menu = useFloatingMenu({
    placement: 'right-end',
    open: true,
    onOpenChange: (open) => { if (!open) onClose(); },
  });

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
  const tokenUsage = usage.tokenUsage;
  const accountLimitMessage = usage.accountUsageConfigured
    ? usage.accountUsageError
      ? `Configured account usage endpoint did not return Fugu limits: ${usage.accountUsageError}`
      : 'Configured account usage endpoint did not return Fugu limits.'
    : 'Sakana account limits are not available from the configured API key. Showing local Fugu token totals only. Set FUGU_ACCOUNT_USAGE_URL in ~/.config/nimbalyst-secrets/sakana-fugu.env to show real 5-hour and 7-day quotas.';

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="w-64 bg-nim-secondary border border-nim rounded-lg shadow-lg z-50 overflow-y-auto"
        data-testid="fugu-usage-popover"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-nim">
          <div className="flex items-center gap-2">
            <div className="w-[18px] h-[18px] rounded-full bg-cyan-500/20 text-cyan-300 flex items-center justify-center text-[9px] font-bold">
              Fu
            </div>
            <span className="text-[14px] font-semibold text-nim">Fugu Usage</span>
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

        <div className="px-4 py-3">
          {usage.error ? (
            <div className="text-[13px] text-nim-error">{usage.error}</div>
          ) : (
            <>
              {limitsAvailable ? (
                <>
                  <UsageSection
                    title="Session"
                    subtitle="5-hour window"
                    utilization={usage.fiveHour.utilization}
                    resetsAt={usage.fiveHour.resetsAt}
                    color={sessionColor as 'green' | 'yellow' | 'red' | 'muted'}
                    windowDurationMs={5 * 60 * 60 * 1000}
                  />
                  <UsageSection
                    title="Weekly"
                    subtitle="7-day window"
                    utilization={usage.sevenDay.utilization}
                    resetsAt={usage.sevenDay.resetsAt}
                    color={weeklyColor as 'green' | 'yellow' | 'red' | 'muted'}
                    windowDurationMs={7 * 24 * 60 * 60 * 1000}
                  />
                </>
              ) : (
                <div className="mb-3 text-[12px] text-nim-muted">
                  {accountLimitMessage}
                </div>
              )}

              {tokenUsage && (
                <div className="rounded-md border border-nim bg-nim-tertiary/40 px-3 py-2 text-[12px] text-nim">
                  <div className="font-semibold mb-1">Tokens</div>
                  <UsageValue label="Input" value={formatNumber(tokenUsage.inputTokens)} />
                  <UsageValue label="Output" value={formatNumber(tokenUsage.outputTokens)} />
                  <UsageValue label="Total" value={formatNumber(tokenUsage.totalTokens)} />
                  <UsageValue label="Sessions" value={formatNumber(tokenUsage.sessionCount)} />
                </div>
              )}
            </>
          )}
        </div>

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
            onClick={() => window.electronAPI.openExternal('https://console.sakana.ai/billing')}
            className="flex items-center gap-1 text-[11px] text-nim-muted hover:text-nim transition-colors"
          >
            <MaterialSymbol icon="open_in_new" size={12} />
            <span>Sakana Billing</span>
          </button>
        </div>
      </div>
    </FloatingPortal>
  );
};

const UsageValue: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex justify-between gap-4">
    <span className="text-nim-muted">{label}</span>
    <span className="font-medium">{value}</span>
  </div>
);

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

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
