/**
 * ClaudeUsageIndicator - Circular progress indicator for Claude Code usage
 *
 * Displays the usage windows as concentric progress rings in the navigation
 * gutter. Rings follow the popover's top-to-bottom order from outer to inner.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import {
  claudeUsageAtom,
  claudeUsageAvailableAtom,
  claudeUsageSessionColorAtom,
  formatResetTime,
} from '../../store/atoms/claudeUsageAtoms';
import { ClaudeUsagePopover } from './ClaudeUsagePopover';
import { refreshClaudeUsage } from '../../store/listeners/claudeUsageListeners';

const OUTER_RING_RADIUS = 12;
const INNER_RING_RADIUS = 8;
const MAX_RING_STROKE_WIDTH = 2.5;

const SCOPED_RING_COLORS = [
  'stroke-purple-500',
  'stroke-cyan-500',
  'stroke-orange-500',
  'stroke-pink-500',
] as const;

interface UsageRing {
  id: string;
  label: string;
  utilization: number;
  resetsAt: string | null;
  colorClass: string;
}

interface RingGeometry extends UsageRing {
  radius: number;
  strokeWidth: number;
  circumference: number;
}

/** Keep every ring visible while reserving a readable centre for the percentage. */
function withRingGeometry(rings: UsageRing[]): RingGeometry[] {
  if (rings.length === 0) return [];

  const radialStep = rings.length === 1
    ? 0
    : (OUTER_RING_RADIUS - INNER_RING_RADIUS) / (rings.length - 1);
  const strokeWidth = rings.length === 1
    ? MAX_RING_STROKE_WIDTH
    : Math.min(MAX_RING_STROKE_WIDTH, radialStep * 0.72);

  return rings.map((ring, index) => {
    const radius = rings.length === 1
      ? OUTER_RING_RADIUS
      : OUTER_RING_RADIUS - radialStep * index;
    return {
      ...ring,
      radius,
      strokeWidth,
      circumference: 2 * Math.PI * radius,
    };
  });
}

interface ClaudeUsageIndicatorProps {
  className?: string;
}

export const ClaudeUsageIndicator: React.FC<ClaudeUsageIndicatorProps> = ({ className }) => {
  const usage = useAtomValue(claudeUsageAtom);
  const isAvailable = useAtomValue(claudeUsageAvailableAtom);
  const sessionColor = useAtomValue(claudeUsageSessionColorAtom);

  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(() => {
    setIsPopoverOpen((prev) => !prev);
  }, []);

  const handleRefresh = useCallback(async () => {
    await refreshClaudeUsage();
  }, []);

  if (!isAvailable) {
    return null;
  }

  const hasLoadError = Boolean(usage?.error);
  const utilization = hasLoadError ? 0 : usage?.fiveHour?.utilization ?? 0;

  // Color mapping
  const colorClasses: Record<string, string> = {
    green: 'stroke-green-500',
    yellow: 'stroke-yellow-500',
    red: 'stroke-red-500',
    muted: 'stroke-nim-muted',
  };

  const effectiveSessionColor = hasLoadError ? 'muted' : sessionColor;
  const sessionStrokeColor = colorClasses[effectiveSessionColor] || colorClasses.muted;

  const usageRings = withRingGeometry([
    {
      id: 'session',
      label: 'Session',
      utilization,
      resetsAt: usage?.fiveHour?.resetsAt ?? null,
      colorClass: sessionStrokeColor,
    },
    {
      id: 'weekly',
      label: 'Weekly',
      utilization: hasLoadError ? 0 : usage?.sevenDay?.utilization ?? 0,
      resetsAt: usage?.sevenDay?.resetsAt ?? null,
      colorClass: hasLoadError ? colorClasses.muted : 'stroke-blue-500',
    },
    ...(usage?.scopedLimits ?? [])
      .filter((limit) => limit.utilization > 0)
      .map((limit, index) => ({
        id: limit.id,
        label: `${limit.label} (Weekly)`,
        utilization: hasLoadError ? 0 : limit.utilization,
        resetsAt: limit.resetsAt,
        colorClass: hasLoadError
          ? colorClasses.muted
          : SCOPED_RING_COLORS[index % SCOPED_RING_COLORS.length],
      })),
  ]);

  const tooltipContent = usage?.error
    ? `Claude usage unavailable: ${usage.error}`
    : usage
      ? usageRings
          .map((ring) => `${ring.label}: ${Math.round(ring.utilization)}% (resets ${formatResetTime(ring.resetsAt)})`)
          .join('\n')
      : 'Claude usage unavailable';

  return (
    <div className={`relative ${className || ''}`}>
      <button
        ref={buttonRef}
        onClick={handleClick}
        title={tooltipContent}
        className="relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2"
        aria-label="Claude Usage"
        data-testid="claude-usage-indicator"
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 32 32"
          className="transform -rotate-90"
          aria-hidden="true"
        >
          {usageRings.map((ring) => (
            <React.Fragment key={ring.id}>
              <circle
                cx="16"
                cy="16"
                r={ring.radius}
                fill="none"
                className="stroke-nim-tertiary"
                strokeWidth={ring.strokeWidth}
              />
              <circle
                cx="16"
                cy="16"
                r={ring.radius}
                fill="none"
                className={ring.colorClass}
                strokeWidth={ring.strokeWidth}
                strokeLinecap="round"
                strokeDasharray={ring.circumference}
                strokeDashoffset={ring.circumference * (1 - Math.min(100, Math.max(0, ring.utilization)) / 100)}
                style={{ transition: 'stroke-dashoffset 0.3s ease' }}
                data-testid={`claude-usage-ring-${ring.id}`}
                data-usage-label={ring.label}
              />
            </React.Fragment>
          ))}
        </svg>
        {/* Percentage text */}
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-nim">
          {hasLoadError ? '--' : `${Math.round(utilization)}%`}
        </span>
      </button>

      {/* Popover */}
      {isPopoverOpen && (
        <ClaudeUsagePopover
          anchorRef={buttonRef}
          onClose={() => setIsPopoverOpen(false)}
          onRefresh={handleRefresh}
        />
      )}
    </div>
  );
};
