/**
 * OllamaUsageIndicator - Circular progress indicator for Ollama Cloud usage
 *
 * Mirrors GeminiUsageIndicator.tsx. Renders `null` (nothing, no gap) until
 * `ollamaUsageAvailableAtom` says otherwise -- hidden for a user who's never
 * set OLLAMA_API_KEY, visible (muted, with error in tooltip) on a transient
 * failure once a key IS configured, visible with a live percentage once the
 * account-usage API responds. See ollamaUsageAtoms.ts for the exact split.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import {
  ollamaUsageAtom,
  ollamaUsageAvailableAtom,
  ollamaUsageWeeklyColorAtom,
  formatResetTime,
} from '../../store/atoms/ollamaUsageAtoms';
import { OllamaUsagePopover } from './OllamaUsagePopover';
import { refreshOllamaUsage } from '../../store/listeners/ollamaUsageListeners';

const RING_RADIUS = 12;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface OllamaUsageIndicatorProps {
  className?: string;
}

export const OllamaUsageIndicator: React.FC<OllamaUsageIndicatorProps> = ({ className }) => {
  const usage = useAtomValue(ollamaUsageAtom);
  const isAvailable = useAtomValue(ollamaUsageAvailableAtom);
  const weeklyColor = useAtomValue(ollamaUsageWeeklyColorAtom);

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
  // Weekly is the primary ring: session resets too fast to be a useful
  // at-a-glance signal most of the time (closer analog to Claude's 7-day ring).
  const utilization = hasLoadError ? 0 : usage?.weekly?.utilization ?? 0;
  const strokeDashoffset = RING_CIRCUMFERENCE * (1 - utilization / 100);
  const limitsAvailable = !hasLoadError && (usage?.limitsAvailable ?? false);

  const colorClasses: Record<string, string> = {
    green: 'stroke-green-500',
    yellow: 'stroke-yellow-500',
    red: 'stroke-red-500',
    muted: 'stroke-nim-muted',
  };

  const effectiveColor = limitsAvailable ? weeklyColor : 'muted';
  const strokeColor = colorClasses[effectiveColor] || colorClasses.muted;

  const tooltipContent = usage?.error
    ? `Ollama usage unavailable: ${usage.error}`
    : usage && limitsAvailable && usage.weekly
      ? `Ollama weekly: ${Math.round(utilization)}%${usage.weekly.resetsAt ? ` (resets ${formatResetTime(usage.weekly.resetsAt)})` : ''}`
      : 'Ollama usage (limits unavailable)';

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
          {limitsAvailable ? `${Math.round(utilization)}%` : '--'}
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
