/**
 * FuguUsageIndicator - Sakana Fugu usage indicator for the navigation gutter.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import {
  fuguUsageAtom,
  fuguUsageAvailableAtom,
  fuguUsageSessionColorAtom,
  formatResetTime,
} from '../../store/atoms/fuguUsageAtoms';
import { useSetting } from '../../hooks/useSetting';
import { FuguUsagePopover } from './FuguUsagePopover';
import { refreshFuguUsage } from '../../store/listeners/fuguUsageListeners';

const RING_RADIUS = 12;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface FuguUsageIndicatorProps {
  className?: string;
}

export const FuguUsageIndicator: React.FC<FuguUsageIndicatorProps> = ({ className }) => {
  const usage = useAtomValue(fuguUsageAtom);
  const isAvailable = useAtomValue(fuguUsageAvailableAtom);
  const isEnabled = useSetting('ai.showFuguUsageIndicator');
  const sessionColor = useAtomValue(fuguUsageSessionColorAtom);

  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(() => {
    setIsPopoverOpen((prev) => !prev);
  }, []);

  const handleRefresh = useCallback(async () => {
    await refreshFuguUsage();
  }, []);

  if (!isEnabled || !isAvailable) {
    return null;
  }

  const hasLoadError = Boolean(usage?.error);
  const utilization = hasLoadError ? 0 : usage?.fiveHour?.utilization ?? 0;
  const strokeDashoffset = RING_CIRCUMFERENCE * (1 - utilization / 100);
  const limitsAvailable = !hasLoadError && (usage?.limitsAvailable ?? true);

  const colorClasses: Record<string, string> = {
    green: 'stroke-cyan-400',
    yellow: 'stroke-yellow-500',
    red: 'stroke-red-500',
    muted: 'stroke-nim-muted',
  };

  const effectiveSessionColor = limitsAvailable ? sessionColor : 'muted';
  const strokeColor = colorClasses[effectiveSessionColor] || colorClasses.muted;
  const tokenLabel = formatShortTokens(usage?.tokenUsage?.totalTokens ?? 0);

  const tooltipContent = usage?.error
    ? `Fugu usage unavailable: ${usage.error}`
    : usage
      ? limitsAvailable
        ? `Fugu: ${Math.round(utilization)}% (resets ${formatResetTime(usage.fiveHour.resetsAt)})`
        : `Fugu account limit unavailable; local tokens ${tokenLabel}`
      : 'Fugu usage unavailable';

  return (
    <div className={`relative ${className || ''}`}>
      <button
        ref={buttonRef}
        onClick={handleClick}
        title={tooltipContent}
        className="relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2"
        aria-label="Fugu Usage"
        data-testid="fugu-usage-indicator"
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
          {limitsAvailable ? `${Math.round(utilization)}%` : '--'}
        </span>
      </button>

      {isPopoverOpen && (
        <FuguUsagePopover
          anchorRef={buttonRef}
          onClose={() => setIsPopoverOpen(false)}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
};

function formatShortTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(tokens));
}
