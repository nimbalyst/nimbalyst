/**
 * OllamaUsagePopover - Detailed Ollama usage information popover
 *
 * Shows current request activity and any supplied legacy utilization or cost.
 * Unavailable billing limits remain distinct from failures to retrieve activity.
 */

import { CostPeriodSection } from './CostPeriodSection';
import React, { useEffect, RefObject } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  ollamaUsageAtom,
  ollamaUsageSessionColorAtom,
  ollamaUsageWeeklyColorAtom,
  formatResetTime,
  OllamaUsageWindow,
} from '../../store/atoms/ollamaUsageAtoms';
import { toggleGutterItemHiddenAtom } from '../../store/atoms/appSettings';
import { openSettingsCommandAtom } from '../../store/atoms/settingsNavigation';
import { useFloatingMenu, FloatingPortal } from '../../hooks/useFloatingMenu';
import { loadOllamaResetTimes } from '../../store/listeners/ollamaUsageListeners';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { OLLAMA_RESET_SCRAPE_ENABLED, resetTimestamp, resetWindow, OLLAMA_NOMINAL_WINDOW_MS, type OllamaWindowKind } from '../../../shared/ollamaResetWindows';
import { formatOllamaUsageTimestamp } from '../../../shared/ollamaUsage';

interface OllamaUsagePopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onRefresh: () => Promise<void>;
}

interface UsageSectionProps {
  title: string;
  kind: OllamaWindowKind;
  window: OllamaUsageWindow;
  color: 'green' | 'yellow' | 'red' | 'muted';
  now: number;
  hideResetTimes: boolean;
  showModelRows?: boolean;
  isDashboard?: boolean;
}

const UsageSection: React.FC<UsageSectionProps> = ({ title, kind, window, color, now, hideResetTimes, showModelRows = true, isDashboard = false }) => {
  const colorClasses: Record<string, { text: string; bar: string }> = {
    green: { text: 'text-green-500', bar: 'bg-green-500' },
    yellow: { text: 'text-yellow-500', bar: 'bg-yellow-500' },
    red: { text: 'text-red-500', bar: 'bg-red-500' },
    muted: { text: 'text-nim-muted', bar: 'bg-nim-muted' },
  };
  const colors = colorClasses[color] || colorClasses.muted;
  const showProviderReset = isDashboard && window.resetsAt && !hideResetTimes;
  const reset = hideResetTimes || isDashboard ? null : resetTimestamp(window.resetsAt);
  const end = reset ? Date.parse(reset) : NaN;
  const bounds = reset ? resetWindow({ ...window, windowEnd: window.windowEnd ?? reset }, kind) : null;
  const start = Date.parse(bounds?.windowStart ?? '');
  const hasReset = Number.isFinite(end) && end > now;
  const elapsed = hasReset && Number.isFinite(start) && end > start && bounds?.windowEnd === reset
    ? Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100)) : null;
  const nominalLength = kind === 'session'
    ? `${OLLAMA_NOMINAL_WINDOW_MS[kind] / (60 * 60 * 1000)}-hour`
    : `${OLLAMA_NOMINAL_WINDOW_MS[kind] / (24 * 60 * 60 * 1000)}-day`;

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
        {elapsed !== null && <div
          className="absolute top-0 h-full w-0.5 bg-white transition-all duration-300"
          style={{ left: `${elapsed}%` }}
          title={bounds?.durationSource === 'nominal'
            ? `About ${Math.round(elapsed)}% of the nominal ${nominalLength} window elapsed`
            : `${Math.round(elapsed)}% of window elapsed`}
        />}
      </div>
      {showProviderReset ? (
        <div className="flex items-center gap-1 text-[11px] text-nim-muted">
          <MaterialSymbol icon="schedule" size={12} className="opacity-70" />
          <span>Resets at {window.resetsAt}</span>
        </div>
      ) : OLLAMA_RESET_SCRAPE_ENABLED && (hasReset ? (
        <div className="flex items-center gap-1 text-[11px] text-nim-muted">
          <MaterialSymbol icon="schedule" size={12} className="opacity-70" />
          <span>Resets in {formatResetTime(reset)}</span>
        </div>
      ) : OLLAMA_RESET_SCRAPE_ENABLED ? <div className="text-[11px] text-nim-muted">Reset time unavailable</div> : null)}
      {showModelRows && window.modelCountsAvailable === false && <div className="mt-1 text-[11px] text-nim-muted">Model call counts unavailable.</div>}
      {showModelRows && window.models.length > 0 && (
        <div className="mt-1 text-[11px] text-nim-muted">
          {window.models.map((m) => `${m.name} (${m.requestCount})`).join(', ')}
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
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  const sessionColor = useAtomValue(ollamaUsageSessionColorAtom);
  const weeklyColor = useAtomValue(ollamaUsageWeeklyColorAtom);
  const toggleGutterItemHidden = useSetAtom(toggleGutterItemHiddenAtom);
  const openSettings = useSetAtom(openSettingsCommandAtom);
  const setUsage = useSetAtom(ollamaUsageAtom);
  const store = useStore();
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [now, setNow] = React.useState(Date.now);
  const [connectNotice, setConnectNotice] = React.useState<string | null>(null);

  useEffect(() => { if (usage?.source !== 'ollama-dashboard' && OLLAMA_RESET_SCRAPE_ENABLED) void loadOllamaResetTimes(); }, [workspacePath, usage?.source]);
  useEffect(() => {
    if (!OLLAMA_RESET_SCRAPE_ENABLED || usage?.source === 'ollama-dashboard') return;
    // Local clock repaint only: this interval never requests a scrape.
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [usage?.source]);
  useEffect(() => {
    if (!OLLAMA_RESET_SCRAPE_ENABLED || usage?.source === 'ollama-dashboard') return;
    // One wake at the earliest known boundary, only while the panel is open.
    const ends = [usage?.session?.resetsAt, usage?.weekly?.resetsAt]
      .map(value => Date.parse(resetTimestamp(value) ?? ''))
      .filter(end => Number.isFinite(end) && end > Date.now());
    if (!ends.length) return;
    const delay = Math.min(...ends) - Date.now() + 20;
    if (delay > 2_147_483_647) return;
    const timer = setTimeout(() => { setNow(Date.now()); void loadOllamaResetTimes(); }, delay);
    return () => clearTimeout(timer);
  }, [workspacePath, usage?.source, usage?.session?.resetsAt, usage?.weekly?.resetsAt]);

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
    if (usage?.source !== 'ollama-dashboard' && OLLAMA_RESET_SCRAPE_ENABLED) await loadOllamaResetTimes();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleConnect = async () => {
    if (!workspacePath || isRefreshing) return;
    setIsRefreshing(true);
    setConnectNotice(null);
    try {
      const result = await window.electronAPI.invoke('ollama-usage:connect', workspacePath);
      if (store.get(activeWorkspacePathAtom) === workspacePath && result) setUsage(result);
      setConnectNotice(result?.source === 'ollama-dashboard' && result.authStatus === 'connected' && !result.error
        ? 'Ollama account connected.'
        : result?.authStatus === 'sign-in-required'
          ? 'Ollama sign-in was cancelled or did not complete.'
          : 'Ollama sign-in could not be verified.');
    } catch {
      setConnectNotice('Ollama sign-in could not be completed.');
    } finally {
      setIsRefreshing(false);
    }
  };

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
          {!usage ? (
            <div className="text-[13px] text-nim-muted">Loading Ollama usage…</div>
          ) : usage.error ? (
            <>
              <div className="text-[13px] text-nim-error">{usage.error}</div>
              {usage.authStatus === 'sign-in-required' && (
                <button type="button" className="nim-button mt-3" onClick={async () => {
                  await handleConnect();
                }} disabled={!workspacePath || isRefreshing}>Connect Ollama account</button>
              )}
            </>
          ) : (
            <>
              {usage.requestUsage && (
                <section className="mb-3" aria-label="Request activity">
                  <div className="text-[11px] text-nim-muted">Request activity</div>
                  <div className="text-[20px] font-semibold text-nim">{usage.requestUsage.requestCount.toLocaleString()} <span className="text-[12px] font-normal text-nim-muted">requests</span></div>
                  <div className="text-[11px] text-nim-muted" title={`${usage.requestUsage.from} – ${usage.requestUsage.until}`}>
                    <div>From {formatOllamaUsageTimestamp(usage.requestUsage.from)}</div>
                    <div>Through {formatOllamaUsageTimestamp(usage.requestUsage.until)}</div>
                  </div>
                </section>
              )}
              {usage.limitsUnavailableReason && (
                <div className="mb-3 text-[11px] text-nim-muted">{usage.limitsUnavailableReason}</div>
              )}
              {usage.authStatus === 'sign-in-required' && (
                <section className="mb-3 rounded-md bg-nim-tertiary p-3">
                  <div className="text-[13px] font-medium text-nim">Sign in to view Ollama usage</div>
                  <button type="button" className="nim-button mt-2" onClick={() => void handleConnect()} disabled={!workspacePath || isRefreshing}>Connect Ollama account</button>
                </section>
              )}
              {usage.source === 'ollama-dashboard' && (
                <section className="mb-3" aria-label="Ollama plan and credits">
                  {usage.plan && <div className="text-[13px] font-semibold text-nim">{usage.plan} plan</div>}
                  {typeof usage.creditBalanceUSD === 'number' && <div className="text-[12px] text-nim-muted">Extra credit balance: ${usage.creditBalanceUSD.toFixed(2)}</div>}
                </section>
              )}
              {OLLAMA_RESET_SCRAPE_ENABLED && (usage.cookieExpired || usage.resetTimeStatus === 'cookie-expired' || usage.resetTimeStatus === 'error') && (
                <div role="alert" className="mb-3 text-[11px] text-nim-error bg-red-500/10 rounded-md px-2.5 py-2">
                  {usage.cookieExpired || usage.resetTimeStatus === 'cookie-expired'
                    ? 'Ollama session cookie expired. Replace it in Settings → Ollama to restore reset times.'
                    : usage.resetTimeRetryAt && usage.resetTimeRetryAt > now
                      ? `Ollama reset-time storage is unavailable. Waiting after startup; retry in about ${Math.ceil((usage.resetTimeRetryAt - now) / 60_000)} minutes.`
                    : 'Ollama reset times could not be read. Check the session cookie in Settings → Ollama.'}
                </div>
              )}
              {usage.session && (
                <UsageSection title={usage.source === 'ollama-dashboard' ? 'Session usage' : 'Legacy session'} kind="session" window={usage.session} color={sessionColor as 'green' | 'yellow' | 'red' | 'muted'} now={now} hideResetTimes={usage.source !== 'ollama-dashboard' && (!OLLAMA_RESET_SCRAPE_ENABLED || Boolean(usage.cookieExpired || usage.resetTimeStatus === 'cookie-expired' || usage.resetTimeStatus === 'error'))} showModelRows={usage.source !== 'ollama-dashboard'} isDashboard={usage.source === 'ollama-dashboard'} />
              )}
              {usage.source === 'ollama-dashboard' && (
                <section className="mb-3" aria-label="Model calls this week">
                  <div className="mb-1 text-[12px] font-semibold text-nim">{usage.modelCountsPeriod === 'this-week' ? 'Models used this week' : 'Model call counts'}</div>
                  {usage.modelCountsPeriod !== 'this-week' || !usage.weekly || usage.weekly.modelCountsAvailable !== true
                    ? <div className="text-[11px] text-nim-muted">Model call counts unavailable.</div>
                    : usage.weekly?.models.length
                      ? <ul className="space-y-0.5 text-[11px] text-nim-muted">{usage.weekly.models.map((model) => <li key={model.name} className="flex justify-between gap-3"><span>{model.name}</span><span>{model.requestCount.toLocaleString()}</span></li>)}</ul>
                      : <div className="text-[11px] text-nim-muted">No model call rows were supplied for this week.</div>}
                </section>
              )}
              {usage.weekly && (
                <UsageSection title={usage.source === 'ollama-dashboard' ? 'Weekly usage' : 'Legacy weekly'} kind="weekly" window={usage.weekly} color={weeklyColor as 'green' | 'yellow' | 'red' | 'muted'} now={now} hideResetTimes={usage.source !== 'ollama-dashboard' && (!OLLAMA_RESET_SCRAPE_ENABLED || Boolean(usage.cookieExpired || usage.resetTimeStatus === 'cookie-expired' || usage.resetTimeStatus === 'error'))} showModelRows={usage.source !== 'ollama-dashboard'} isDashboard={usage.source === 'ollama-dashboard'} />
              )}
              {usage.costPeriod ? (
                <CostPeriodSection costPeriod={usage.costPeriod} costUSD={usage.costUSD} />
              ) : usage.costUSD !== undefined ? (
                <div className="text-[11px] text-nim-muted mt-1">
                  Metered cost this period: ${usage.costUSD.toFixed(5)}
                </div>
              ) : null}
            </>
          )}
          {connectNotice && <div className="mt-2 text-[11px] text-nim-muted" role="status">{connectNotice}</div>}
          <button
            onClick={() => window.electronAPI.openExternal('https://ollama.com/settings')}
            className="mt-3 text-[11px] text-nim-muted hover:text-nim underline"
          >
            View current usage in Ollama
          </button>
        </div>

        <div className="px-4 py-2 border-t border-nim flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            {usage?.lastUpdated && (
              <span className="text-[10px] text-nim-faint">
                Observed {formatLastUpdated(usage.lastUpdated)}
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
            onClick={() => {
              openSettings({ category: 'ollama', scope: 'application', timestamp: Date.now() });
              onClose();
            }}
            className="flex items-center gap-1 text-[11px] text-nim-muted hover:text-nim transition-colors"
          >
            <MaterialSymbol icon="settings" size={12} />
            <span>Configure Ollama in Nimbalyst</span>
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
