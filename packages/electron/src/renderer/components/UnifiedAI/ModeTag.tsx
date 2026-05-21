import React from 'react';
import { HelpTooltip } from '../../help';

export type AIMode = 'planning' | 'agent' | 'auto';

interface ModeStyle {
  label: string;
  className: string;
  ariaPrefix: string;
}

// Visual styles for the two user-facing modes. `auto` is intentionally
// absent — it is activated transparently via the "Allow All" trust level
// (see ClaudeCodeProvider) and does not appear in the toggle cycle.
// The `auto` entry in `AIMode` is kept for backward compat with sessions
// persisted before this change; stale `auto` collapses to `agent` below.
const STYLES: Record<'planning' | 'agent', ModeStyle> = {
  planning: {
    label: 'Plan',
    className:
      'mode-tag-plan bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-400 dark:hover:bg-blue-900/60',
    ariaPrefix: 'Plan mode: Creates plan documents',
  },
  agent: {
    label: 'Agent',
    className:
      'mode-tag-agent bg-orange-100 text-orange-600 hover:bg-orange-200 dark:bg-orange-900/40 dark:text-orange-400 dark:hover:bg-orange-900/60',
    ariaPrefix: 'Agent mode: Full tool access',
  },
};

/**
 * Ordered list of user-facing modes. The cycle order is the array order
 * (last entry wraps back to the first).
 *
 * Auto mode is not in this list — it is activated transparently when the
 * workspace trust level is "Allow All" and the provider supports the SDK
 * classifier (see ClaudeCodeProvider.sendMessage, issue #371). The user
 * only sees Plan and Agent in the toggle.
 */
export function buildModeList(_provider?: string | null): AIMode[] {
  return ['planning', 'agent'];
}

export function nextMode(mode: AIMode, provider: string | null | undefined): AIMode {
  const list = buildModeList(provider);
  const currentIndex = list.indexOf(mode);
  // If the mode is not in the provider's supported list (e.g. stale `auto`
  // persisted from a previous claude-code session, then provider swapped),
  // treat it as if we were at index 0 so the next click advances normally.
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  return list[(safeIndex + 1) % list.length];
}

interface ModeTagProps {
  mode: AIMode;
  onModeChange: (mode: AIMode) => void;
  provider: string | null | undefined;
}

/**
 * ModeTag - Compact toggle between Plan and Agent modes.
 *
 * Plan mode: Creates plan documents, restricted to markdown files
 * Agent mode: Full tool access, write operations enabled
 *
 * Auto mode is handled transparently via the "Allow All" trust level
 * (issue #371) and does not appear in this toggle.
 */
export function ModeTag({ mode, onModeChange, provider }: ModeTagProps) {
  const supportedModes = buildModeList(provider);
  // Stale `auto` from an older session collapses to `agent` so the visible
  // state matches the two-mode cycle.
  const visibleMode: 'planning' | 'agent' = supportedModes.includes(mode) ? (mode as 'planning' | 'agent') : 'agent';
  const next = nextMode(visibleMode, provider);
  const style = STYLES[visibleMode];
  const nextLabel = STYLES[next].label;

  return (
    <HelpTooltip testId="plan-mode-toggle">
      <button
        data-testid="plan-mode-toggle"
        data-mode={visibleMode}
        className={`mode-tag px-2.5 py-0.5 rounded-xl text-[11px] font-semibold uppercase tracking-wide border-none cursor-pointer transition-all duration-200 outline-none hover:-translate-y-px hover:shadow-md active:translate-y-0 ${style.className}`}
        onClick={() => onModeChange(next)}
        aria-label={`${style.ariaPrefix} (click to switch to ${nextLabel} mode)`}
        type="button"
      >
        {style.label}
      </button>
    </HelpTooltip>
  );
}
