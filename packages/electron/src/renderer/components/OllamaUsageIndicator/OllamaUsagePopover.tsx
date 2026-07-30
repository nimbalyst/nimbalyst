/**
 * OllamaUsagePopover - Detailed Ollama Cloud usage information popover
 *
 * Shows session + weekly utilization with progress bars, the top requested
 * models per window, and local LiteLLM brain-swap proxy health as secondary
 * info. Mirrors GeminiUsagePopover.tsx's structure.
 */

import React, { useEffect, RefObject } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  ollamaUsageAtom,
  ollamaUsageSessionColorAtom,
  ollamaUsageWeeklyColorAtom,
  formatResetTime,
  OllamaUsageWindow,
} from '../../store/atoms/ollamaUsageAtoms';
import { toggleGutterItemHiddenAtom } from '../../store/atoms/appSettings';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';

interface OllamaUsagePopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

interface UsageSectionProps {
  title: string;
  window: OllamaUsageWindow;
  color: 'green' | 'yellow' | 'red' | 'muted';
}

const UsageSection: React.FC<UsageSectionProps> = ({ title, window, color }) => {
  const colorClasses: Record<string, { text: string; bar: string }> = {
    green: { text: 'text-green-500', bar: 'bg-green-500' },
    yellow: { text: 'text-yellow-500', bar: 'bg-yellow-500' },
    red: { text: 'text-red-500', bar: 'bg-red-500' },
    muted: { text: 'text-nim-muted', bar: 'bg-nim-muted' },
  };
  const colors = colorClasses[color] || colorClasses.muted;
  const topModels = [...window.models]
    .sort((a, b) => b.requestCount - a.requestCount)
    .slice(0, 3);

  return (
    <div className="mb-4 last:mb-0">
      <div className="flex justify-between items-baseline mb-1">
        <div className="text-[13px] font-semibold text-nim">{title}</div>
        <div className={`text-[16px] font-semibold ${colors.text}`}>
          {window.utilization}%
        </div>
      </div>
      <div className="relative h-1.5 bg-nim-tertiary rounded-full overflow-hidden mb-1.5">
        <div
          className={`h-full rounded-full transition-all duration-300 ${colors.bar}`}
          style={{ width: `${Math.min(window.utilization, 100)}%` }}
        />
      </div>
      {window.resetsAt ? (
        <div className="flex items-center gap-1 text-[11px] text-nim-muted">
          <MaterialSymbol icon="schedule" size={12} className="opacity-70" />
          <span>Resets in {formatResetTime(window.resetsAt)}</span>
        </div>
      ) : null}
      {topModels.length > 0 && (
        <div className="mt-1 text-[11px] text-nim-muted">
          {topModels.map((m) => `${m.name} (${m.requestCount})`).join(', ')}
        </div>
      )}
    </div>
  );
};

export const OllamaUsagePopover: React.FC<OllamaUsagePopoverProps> = ({
  anchorRef,
  onClose,
  onRefresh,
}) => {
  const usage = useAtomValue(ollamaUsageAtom);
  const sessionColor = useAtomValue(ollamaUsageSessionColorAtom);
  const weeklyColor = useAtomValue(ollamaUsageWeeklyColorAtom);
  const toggleGutterItemHidden = useSetAtom(toggleGutterItemHiddenAtom);
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

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        style={menu.floatingStyles}
        {...menu.getFloatingProps()}
        className="w-64 bg-nim-secondary border border-nim rounded-lg shadow-lg z-50 overflow-y-auto"
        data-testid="ollama-usage-popover"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-nim">
          <div className="flex items-center gap-2">
            <MaterialSymbol icon="cloud" size={18} className="text-nim-muted" />
            <span className="text-[14px] font-semibold text-nim">Ollama Usage</span>
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
              {usage.session && (
                <UsageSection title="Session" window={usage.session} color={sessionColor as 'green' | 'yellow' | 'red' | 'muted'} />
              )}
              {usage.weekly && (
                <UsageSection title="Weekly" window={usage.weekly} color={weeklyColor as 'green' | 'yellow' | 'red' | 'muted'} />
              )}
              {usage.costUSD !== undefined && (
                <div className="text-[11px] text-nim-muted mt-1">
                  Metered cost this period: ${usage.costUSD.toFixed(5)}
                </div>
              )}
            </>
          )}
          <div className="mt-3 pt-3 border-t border-nim text-[11px] text-nim-muted">
            Local brain-swap proxy: {usage.proxyReachable ? 'reachable' : 'not running'}
            {usage.proxyReachable && usage.configuredAliases.length > 0 && (
              <div className="mt-0.5">{usage.configuredAliases.length} alias{usage.configuredAliases.length === 1 ? '' : 'es'} configured</div>
            )}
          </div>
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
                toggleGutterItemHidden({ id: 'ollama-usage', hidden: true });
                onClose();
              }}
              className="text-[11px] text-nim-muted hover:text-nim transition-colors"
            >
              Disable
            </button>
          </div>
          <button
            onClick={() => window.electronAPI.openExternal('https://ollama.com/settings')}
            className="flex items-center gap-1 text-[11px] text-nim-muted hover:text-nim transition-colors"
          >
            <MaterialSymbol icon="open_in_new" size={12} />
            <span>Ollama Account Settings</span>
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
