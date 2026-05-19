import React from 'react';
import { HelpTooltip } from '../../help';

export type AIMode = 'planning' | 'agent' | 'auto';

interface ModeStyle {
  label: string;
  className: string;
  ariaPrefix: string;
}

const STYLES: Record<AIMode, ModeStyle> = {
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
  auto: {
    label: 'Auto',
    className:
      'mode-tag-auto bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/40 dark:text-violet-400 dark:hover:bg-violet-900/60',
    ariaPrefix:
      'Auto mode: SDK classifier auto-approves safe operations and asks for confirmation on destructive or uncertain ones',
  },
};

/**
 * Ordered list of supported modes for a given provider. The cycle order is
 * the array order (last entry wraps back to the first).
 *
 * - Every provider: Plan, Agent.
 * - `claude-code` only: append Auto. Auto maps to the Claude Agent SDK's
 *   native `permissionMode: 'auto'` classifier (issue #371). Other providers
 *   (Codex, etc.) do not honour it, so it is not surfaced for them. Plan
 *   itself also has known compatibility limits with the Codex harness — we
 *   ship it for parity but treat Auto more strictly to avoid repeating that
 *   class of "feature exists but does nothing" issue.
 */
export function buildModeList(provider: string | null | undefined): AIMode[] {
  const modes: AIMode[] = ['planning', 'agent'];
  if (provider === 'claude-code') {
    modes.push('auto');
  }
  return modes;
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
 * ModeTag - Compact toggle between session modes.
 *
 * Plan mode: Creates plan documents, restricted to markdown files
 * Agent mode: Full tool access, write operations enabled
 * Auto mode (claude-code only): SDK classifier approves safe operations
 *   without prompting and escalates destructive or uncertain ones to the
 *   regular permission prompt. Silent auto-deny only happens for SDK-level
 *   deny rules, not as the classifier's default response to risky tools.
 */
export function ModeTag({ mode, onModeChange, provider }: ModeTagProps) {
  const supportedModes = buildModeList(provider);
  // Stale mode (e.g. `auto` on a non-claude-code provider) collapses to the
  // first supported mode so the visible state reflects what the binary will
  // actually do.
  const visibleMode: AIMode = supportedModes.includes(mode) ? mode : supportedModes[0];
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
