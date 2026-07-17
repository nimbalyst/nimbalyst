import React, { useId, useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { useSetAtom } from 'jotai';
import type { TokenUsageCategory } from '@nimbalyst/runtime/ai/server/types';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { getHelpContent } from '../../help';
import { openSettingsCommandAtom } from '../../store';

const CATEGORY_COLORS = [
  'var(--nim-primary)',
  '#5E81F4',
  '#4AB4D8',
  '#F59E0B',
  '#F97316',
  '#EC4899',
  '#8B5CF6'
];

interface ContextUsageDisplayProps {
  inputTokens: number;       // Cumulative input tokens (for tooltip breakdown)
  outputTokens: number;      // Cumulative output tokens (for tooltip breakdown)
  totalTokens: number;       // Cumulative total tokens (fallback if no currentContext)
  contextWindow: number;     // Context window size (legacy, use currentContext)
  categories?: TokenUsageCategory[];  // Categories (legacy, use currentContext)
  // Current context snapshot for Claude Code (from /context command)
  currentContext?: {
    tokens: number;          // Current tokens in context window
    contextWindow: number;   // Max context window size
    categories?: TokenUsageCategory[];
  };
}

interface FormattedCategory extends TokenUsageCategory {
  color: string;
  width: number;
  percentText: string;
}

/**
 * ContextUsageDisplay shows token usage for AI sessions
 *
 * Display formats:
 * - With context window: "110k/200k Tokens (55%)" - shows percentage usage
 * - Without context window: "15k Tokens" - just shows cumulative total
 * - No data yet: "--"
 */
export function ContextUsageDisplay({
  inputTokens,
  outputTokens,
  totalTokens,
  contextWindow,
  categories,
  currentContext
}: ContextUsageDisplayProps) {
  // For context window display, prefer currentContext (from /context command)
  // Fall back to legacy fields for backward compatibility
  const displayTokens = currentContext?.tokens ?? totalTokens;
  const displayContextWindow = currentContext?.contextWindow ?? contextWindow;
  const displayCategories = currentContext?.categories ?? categories;

  // Check what data we have
  const hasTokenData = displayTokens > 0 || totalTokens > 0;
  const hasContextWindow = displayContextWindow > 0;
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [helpExpanded, setHelpExpanded] = useState(false);
  const [toolBaselineTokens, setToolBaselineTokens] = useState<number | null>(null);
  const openSettings = useSetAtom(openSettingsCommandAtom);
  const tooltipId = useId();
  const helpContent = getHelpContent('context-indicator');
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Calculate percentage used (only meaningful with context window)
  const percentage = hasContextWindow ? Math.round((displayTokens / displayContextWindow) * 100) : 0;

  // Format numbers with k suffix for thousands
  const formatTokensShort = (tokens: number): string => {
    if (tokens >= 1_000_000) {
      const m = tokens / 1_000_000;
      return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
    }
    if (tokens >= 1000) {
      return `${Math.round(tokens / 1000)}k`;
    }
    return tokens.toString();
  };

  const formatPercent = (value: number): string => {
    if (!Number.isFinite(value)) {
      return '0';
    }
    return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  };

  const formattedCategories = useMemo<FormattedCategory[]>(() => {
    if (!displayCategories || displayCategories.length === 0) {
      return [];
    }

    return displayCategories
      .filter(cat => cat && (cat.tokens > 0 || cat.percentage > 0))
      .map((cat, index) => ({
        ...cat,
        color: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
        width: Math.max(0, Math.min(cat.percentage, 100)),
        percentText: formatPercent(cat.percentage)
      }));
  }, [displayCategories]);

  // Categories that represent actual usage (exclude "Free space" from bar fill)
  const usedCategories = useMemo(() => {
    return formattedCategories.filter(cat =>
      !cat.name.toLowerCase().includes('free')
    );
  }, [formattedCategories]);

  // Total width of used categories for the bar fill
  const usedPercentage = useMemo(() => {
    return usedCategories.reduce((sum, cat) => sum + cat.width, 0);
  }, [usedCategories]);

  const enableTooltip = hasTokenData && (formattedCategories.length > 0 || inputTokens > 0 || outputTokens > 0);
  const shouldShowTooltip = tooltipVisible && enableTooltip;

  // Click-to-open: the meter is shaped like a button (model/thinking/action
  // buttons next to it) and sits where the cursor travels often, so a hover
  // popover lingered and blocked the queued-prompt controls underneath it (#429).
  const closeTooltip = useCallback(() => setTooltipVisible(false), []);

  const toggleTooltip = useCallback(() => {
    if (enableTooltip) {
      setTooltipVisible(visible => !visible);
    }
  }, [enableTooltip]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleTooltip();
    } else if (event.key === 'Escape') {
      closeTooltip();
    }
  }, [toggleTooltip, closeTooltip]);

  // Fetch the fixed tool baseline (eager core surface) once when the panel
  // first opens, so the breakdown can show the floor a fresh session starts at.
  useEffect(() => {
    if (!tooltipVisible || toolBaselineTokens !== null) {
      return;
    }
    let cancelled = false;
    (window as any).electronAPI
      ?.invoke('mcp-config:get-tool-budget')
      .then((snapshot: { eagerEstTokens?: number } | null) => {
        if (!cancelled && typeof snapshot?.eagerEstTokens === 'number') {
          setToolBaselineTokens(snapshot.eagerEstTokens);
        }
      })
      .catch(() => {
        // Budget info is a nice-to-have in this popover; skip on failure.
      });
    return () => {
      cancelled = true;
    };
  }, [tooltipVisible, toolBaselineTokens]);

  // Dismiss on outside click or Escape while the panel is open.
  useEffect(() => {
    if (!tooltipVisible) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setTooltipVisible(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTooltipVisible(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [tooltipVisible]);

  const getUsageClass = (): string => {
    if (!hasTokenData) return 'usage-normal';
    if (hasContextWindow && percentage >= 90) return 'usage-critical';
    if (hasContextWindow && percentage >= 80) return 'usage-warning';
    return 'usage-normal';
  };

  // Build display text
  const getDisplayText = (): string => {
    if (!hasTokenData) return '--';
    if (hasContextWindow) {
      return `${formatTokensShort(displayTokens)}/${formatTokensShort(displayContextWindow)} (${percentage}%)`;
    }
    return `${formatTokensShort(displayTokens)} tokens`;
  };

  const label = hasTokenData
    ? hasContextWindow
      ? `Context usage ${formatTokensShort(displayTokens)} of ${formatTokensShort(displayContextWindow)} tokens (${percentage}%)`
      : `Token usage: ${formatTokensShort(displayTokens)} total tokens`
    : 'Token usage data not available yet';

  // Usage level styling
  const usageClass = getUsageClass();
  const usageStyles = {
    'usage-normal': '',
    'usage-warning': 'bg-[rgba(255,165,0,0.1)] border-[rgba(255,165,0,0.3)]',
    'usage-critical': 'bg-[rgba(255,0,0,0.1)] border-[rgba(255,0,0,0.3)]'
  };
  const textStyles = {
    'usage-normal': 'text-[var(--nim-text-muted)]',
    'usage-warning': 'text-orange-500',
    'usage-critical': 'text-[#ff4444]'
  };

  return (
    <div
      ref={rootRef}
      className={`context-usage-display ${usageClass} relative inline-flex items-center py-0.5 px-2 rounded-md text-[11px] font-medium whitespace-nowrap bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] ml-auto ${enableTooltip ? 'cursor-pointer' : 'cursor-default'} gap-1 focus:outline-2 focus:outline-[var(--nim-primary)] focus:outline-offset-2 max-[400px]:hidden ${usageStyles[usageClass as keyof typeof usageStyles]}`}
      tabIndex={hasTokenData ? 0 : -1}
      aria-label={label}
      aria-describedby={shouldShowTooltip ? tooltipId : undefined}
      aria-expanded={enableTooltip ? shouldShowTooltip : undefined}
      onClick={toggleTooltip}
      onKeyDown={handleKeyDown}
      role={enableTooltip ? 'button' : 'group'}
      data-testid="context-indicator"
    >
      <span className={`usage-text ${textStyles[usageClass as keyof typeof textStyles]}`}>{getDisplayText()}</span>

      {shouldShowTooltip && (
        <div
          className="context-usage-tooltip absolute right-0 bottom-[calc(100%+8px)] w-[280px] max-w-[calc(100vw-32px)] p-3 rounded-[10px] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_12px_32px_rgba(0,0,0,0.35)] z-10 text-[var(--nim-text)] overflow-hidden box-border"
          id={tooltipId}
          role="tooltip"
        >
          <div className="tooltip-header flex justify-between items-center text-xs mb-2 text-[var(--nim-text-muted)]">
            <div className="tooltip-header-left flex items-center gap-1.5">
              <span>{hasContextWindow ? 'Context Breakdown' : 'Token Usage'}</span>
              {helpContent && (
                <button
                  className="tooltip-help-button inline-flex items-center justify-center w-[18px] h-[18px] p-0 border-none rounded-full bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)] cursor-pointer transition-all duration-150 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text-muted)]"
                  onClick={(e) => {
                    e.stopPropagation();
                    setHelpExpanded(!helpExpanded);
                  }}
                  title={helpExpanded ? 'Hide help' : 'What is this?'}
                  aria-expanded={helpExpanded}
                >
                  <MaterialSymbol icon={helpExpanded ? 'expand_less' : 'help'} size={14} />
                </button>
              )}
            </div>
            {hasContextWindow && (
              <span className="tooltip-total font-semibold text-[var(--nim-text)]">
                {formatTokensShort(displayTokens)} / {formatTokensShort(displayContextWindow)}
              </span>
            )}
          </div>

          {/* Expandable help section */}
          {helpExpanded && helpContent && (
            <div className="tooltip-help-section bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md p-2.5 mb-2.5 overflow-hidden box-border whitespace-normal">
              <div className="tooltip-help-title text-xs font-semibold text-[var(--nim-text)] mb-1 whitespace-normal">{helpContent.title}</div>
              <div className="tooltip-help-body text-[11px] text-[var(--nim-text-muted)] leading-[1.4] whitespace-normal break-words">{helpContent.body}</div>
            </div>
          )}

          {/* Show input/output breakdown if available */}
          {(inputTokens > 0 || outputTokens > 0) && (
            <div className="tooltip-io-breakdown flex flex-col gap-1 py-2 border-b border-[var(--nim-border)] mb-2">
              <div className="tooltip-io-row flex justify-between text-[11px]">
                <span className="tooltip-io-label text-[var(--nim-text-muted)]">Input:</span>
                <span className="tooltip-io-value text-[var(--nim-text)] tabular-nums">{inputTokens.toLocaleString()}</span>
              </div>
              <div className="tooltip-io-row flex justify-between text-[11px]">
                <span className="tooltip-io-label text-[var(--nim-text-muted)]">Output:</span>
                <span className="tooltip-io-value text-[var(--nim-text)] tabular-nums">{outputTokens.toLocaleString()}</span>
              </div>
              <div className="tooltip-io-row tooltip-io-total flex justify-between text-[11px] font-semibold pt-1 border-t border-[var(--nim-border)] mt-1">
                <span className="tooltip-io-label text-[var(--nim-text-muted)]">Total:</span>
                <span className="tooltip-io-value text-[var(--nim-text)] tabular-nums">{totalTokens.toLocaleString()}</span>
              </div>
            </div>
          )}

          {/* Category bar (only for Claude Code with context data) */}
          {hasContextWindow && formattedCategories.length > 0 && (
            <>
              <div className="tooltip-bar relative h-2.5 rounded-full overflow-hidden bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] mb-2.5">
                <div className="tooltip-bar-fill flex h-full rounded-full" style={{ width: `${usedPercentage}%` }}>
                  {usedCategories.map((cat, index) => {
                    // Calculate width relative to the used portion
                    const relativeWidth = usedPercentage > 0 ? (cat.width / usedPercentage) * 100 : 0;
                    return (
                      <span
                        key={`${cat.name}-${index}`}
                        className="tooltip-bar-segment h-full"
                        style={{ width: `${relativeWidth}%`, backgroundColor: cat.color }}
                      />
                    );
                  })}
                </div>
              </div>

              <div className="tooltip-categories flex flex-col gap-1.5">
                {formattedCategories.map((cat, index) => {
                  const isFreeSpace = cat.name.toLowerCase().includes('free');
                  return (
                    <div
                      className="tooltip-category-row grid grid-cols-[10px_1fr_auto_auto] items-center gap-1.5 text-[11px]"
                      key={`${cat.name}-${index}`}
                    >
                      <span
                        className={`tooltip-dot w-2 h-2 rounded-full inline-block ${isFreeSpace ? 'bg-transparent border border-[var(--nim-border)]' : ''}`}
                        style={isFreeSpace ? undefined : { backgroundColor: cat.color }}
                      />
                      <span className="tooltip-category-name text-[var(--nim-text)]">{cat.name}</span>
                      <span className="tooltip-category-tokens text-[var(--nim-text-muted)] tabular-nums">{cat.tokens.toLocaleString()} tokens</span>
                      <span className="tooltip-category-percent text-[var(--nim-text)] font-semibold tabular-nums">{cat.percentText}%</span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Fixed tool floor + jump to the Tools & MCP panel */}
          <div className="tooltip-tools-footer flex justify-between items-center gap-2 pt-2 mt-2 border-t border-[var(--nim-border)] text-[11px]">
            <span className="tooltip-baseline text-[var(--nim-text-muted)]">
              {toolBaselineTokens !== null
                ? `Always-loaded tools: ~${toolBaselineTokens.toLocaleString()} tokens`
                : 'Other tool groups load on demand'}
            </span>
            <button
              className="tooltip-manage-tools text-[var(--nim-primary)] hover:underline whitespace-nowrap"
              onClick={(e) => {
                e.stopPropagation();
                setTooltipVisible(false);
                openSettings({ category: 'tools-mcp', timestamp: Date.now() });
              }}
            >
              Manage tools
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
