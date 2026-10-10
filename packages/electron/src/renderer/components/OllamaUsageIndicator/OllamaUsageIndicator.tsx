/**
 * OllamaUsageIndicator - Circular progress indicator for Ollama usage
 *
 * Mirrors GeminiUsageIndicator.tsx. The meter is always present in the gutter
 * unless the user explicitly hides it. Before usage data is available it
 * renders a muted `--`; failures remain inspectable through the tooltip and
 * popover instead of making the control disappear.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import {
  ollamaUsageAtom,
  ollamaUsageAvailableAtom,
  ollamaUsageSessionColorAtom,
  ollamaUsageWeeklyColorAtom,
  formatResetTime,
} from '../../store/atoms/ollamaUsageAtoms';
import { OllamaUsagePopover } from './OllamaUsagePopover';
import { refreshOllamaUsage } from '../../store/listeners/ollamaUsageListeners';
import { formatOllamaUsageTimestamp } from '../../../shared/ollamaUsage';

const RING_RADIUS = 12;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface OllamaUsageIndicatorProps {
  className?: string;
}

export const OllamaUsageIndicator: React.FC<OllamaUsageIndicatorProps> = ({ className }) => {
  const usage = useAtomValue(ollamaUsageAtom);
  const isAvailable = useAtomValue(ollamaUsageAvailableAtom);
  const weeklyColor = useAtomValue(ollamaUsageWeeklyColorAtom);
  const sessionColor = useAtomValue(ollamaUsageSessionColorAtom);

  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(() => {
    setIsPopoverOpen((prev) => !prev);
  }, []);

  const handleRefresh = useCallback(async () => {
    await refreshOllamaUsage();
  }, []);

  if (!isAvailable) {
    return null;
  }

  const hasLoadError = Boolean(usage?.error);
  const validWindow = (window: { utilization: number } | undefined) =>
    window && Number.isFinite(window.utilization) && window.utilization >= 0 && window.utilization <= 100;
  const selectedKind = !hasLoadError && usage?.limitsAvailable
    ? validWindow(usage.weekly) ? 'weekly' : validWindow(usage.session) ? 'session' : null
    : null;
  const selectedWindow = selectedKind ? usage?.[selectedKind] : undefined;
  const utilization = selectedWindow?.utilization ?? 0;
  const strokeDashoffset = RING_CIRCUMFERENCE * (1 - utilization / 100);
  const limitsAvailable = Boolean(selectedWindow);

  const colorClasses: Record<string, string> = {
    green: 'stroke-green-500',
    yellow: 'stroke-yellow-500',
    red: 'stroke-red-500',
    muted: 'stroke-nim-muted',
  };

  const effectiveColor = selectedKind === 'weekly' ? weeklyColor : selectedKind === 'session' ? sessionColor : 'muted';
  const strokeColor = colorClasses[effectiveColor] || colorClasses.muted;

  const activity = !hasLoadError ? usage?.requestUsage : undefined;
  const activityLabel = activity
    ? `${activity.requestCount.toLocaleString()} requests (${formatOllamaUsageTimestamp(activity.from)} – ${formatOllamaUsageTimestamp(activity.until)})`
    : undefined;
  const tooltipContent = usage?.error
    ? `Ollama usage unavailable: ${usage.error}`
    : selectedWindow
      ? usage?.source === 'ollama-dashboard'
        ? `Ollama ${selectedKind} usage: ${selectedWindow.utilization}%${selectedWindow.resetsAt ? ` (resets at ${selectedWindow.resetsAt})` : ''}`
        : `Ollama legacy ${selectedKind}: ${Math.round(utilization)}%${selectedWindow.resetsAt ? ` (resets ${formatResetTime(selectedWindow.resetsAt)})` : ''}`
      : activityLabel
        ? `Ollama activity: ${activityLabel}. ${usage?.limitsUnavailableReason ?? ''}`
      : usage
        ? 'Ollama usage (limits unavailable)'
        : 'Ollama usage (loading)';

  return (
    <div className={`relative ${className || ''}`}>
      <button
        ref={buttonRef}
        onClick={handleClick}
        title={tooltipContent}
        className="relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2"
        aria-label="Ollama Usage"
        data-testid="ollama-usage-indicator"
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 32 32"
          className="transform -rotate-90"
        >
          <circle
            cx="16"
            cy="16"
            r={RING_RADIUS}
            fill="none"
            className="stroke-nim-tertiary"
            strokeWidth="3"
          />
          <circle
            cx="16"
            cy="16"
            r={RING_RADIUS}
            fill="none"
            className={strokeColor}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={strokeDashoffset}
            style={{ transition: 'stroke-dashoffset 0.3s ease' }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-nim">
          {limitsAvailable ? `${Math.round(utilization)}%` : activity ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(activity.requestCount) : '--'}
        </span>
      </button>

      {isPopoverOpen && (
        <OllamaUsagePopover
          anchorRef={buttonRef}
          onClose={() => setIsPopoverOpen(false)}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
};
