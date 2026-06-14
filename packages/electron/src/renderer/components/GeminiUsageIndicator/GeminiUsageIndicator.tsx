/**
 * GeminiUsageIndicator - Circular progress indicator for Gemini usage
 *
 * Displays the most-constrained model quota as a circular progress ring in the
 * navigation gutter. Clicking opens a popover with full details. Error states
 * (including "server not started yet") render as a blank ("--") indicator with
 * hover details -- the chip never crashes when the snapshot is unavailable.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import {
  geminiUsageAtom,
  geminiUsageAvailableAtom,
  geminiUsageIndicatorEnabledAtom,
  geminiUsageSessionColorAtom,
  formatResetTime,
} from '../../store/atoms/geminiUsageAtoms';
import { GeminiUsagePopover } from './GeminiUsagePopover';
import { refreshGeminiUsage } from '../../store/listeners/geminiUsageListeners';

const RING_RADIUS = 12;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

interface GeminiUsageIndicatorProps {
  className?: string;
}

export const GeminiUsageIndicator: React.FC<GeminiUsageIndicatorProps> = ({ className }) => {
  const usage = useAtomValue(geminiUsageAtom);
  const isAvailable = useAtomValue(geminiUsageAvailableAtom);
  const isEnabled = useAtomValue(geminiUsageIndicatorEnabledAtom);
  const sessionColor = useAtomValue(geminiUsageSessionColorAtom);

  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(() => {
    setIsPopoverOpen((prev) => !prev);
  }, []);

  const handleRefresh = useCallback(async () => {
    await refreshGeminiUsage();
  }, []);

  if (!isEnabled || !isAvailable) {
    return null;
  }

  const hasLoadError = Boolean(usage?.error);
  const utilization = hasLoadError ? 0 : usage?.fiveHour?.utilization ?? 0;
  const strokeDashoffset = RING_CIRCUMFERENCE * (1 - utilization / 100);
  const limitsAvailable = !hasLoadError && (usage?.limitsAvailable ?? true);

  const colorClasses: Record<string, string> = {
    green: 'stroke-green-500',
    yellow: 'stroke-yellow-500',
    red: 'stroke-red-500',
    muted: 'stroke-nim-muted',
  };

  const effectiveSessionColor = limitsAvailable ? sessionColor : 'muted';
  const strokeColor = colorClasses[effectiveSessionColor] || colorClasses.muted;

  const tooltipContent = usage?.notStarted
    ? usage.error || 'Gemini usage will appear after your first request'
    : usage?.error
      ? `Gemini usage unavailable: ${usage.error}`
      : usage
        ? limitsAvailable
          ? `Gemini: ${Math.round(utilization)}% (resets ${formatResetTime(usage.fiveHour.resetsAt)})`
          : 'Gemini usage (limits unavailable)'
        : 'Gemini usage unavailable';

  return (
    <div className={`relative ${className || ''}`}>
      <button
        ref={buttonRef}
        onClick={handleClick}
        title={tooltipContent}
        className="relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2"
        aria-label="Gemini Usage"
        data-testid="gemini-usage-indicator"
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 32 32"
          className="transform -rotate-90"
        >
          {/* Background ring */}
          <circle
            cx="16"
            cy="16"
            r={RING_RADIUS}
            fill="none"
            className="stroke-nim-tertiary"
            strokeWidth="3"
          />
          {/* Progress ring */}
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
        {/* Percentage text */}
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-nim">
          {limitsAvailable ? `${Math.round(utilization)}%` : '--'}
        </span>
      </button>

      {isPopoverOpen && (
        <GeminiUsagePopover
          anchorRef={buttonRef}
          onClose={() => setIsPopoverOpen(false)}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
};
