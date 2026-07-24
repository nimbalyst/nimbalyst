/**
 * UnifiedDiffHeader - Unified diff approval UI for all editor types
 *
 * This component provides a consistent diff approval experience across
 * Monaco, Lexical, and custom editors. It adapts its UI based on the
 * capabilities provided by each editor type.
 *
 * Features:
 * - Keep All / Revert All (all editors)
 * - Session info display with "Go to Session" (when available)
 * - Change navigation (prev/next) when supported
 * - Per-change keep/revert when supported
 *
 * Note: We use "Keep" / "Revert" terminology because AI changes are already
 * written to disk - we're reviewing changes that have been made, not approving
 * changes that are pending.
 */

import React from 'react';
import { MaterialSymbol, ProviderIcon } from '@nimbalyst/runtime';
import { usePostHog } from 'posthog-js/react';
import type { UnifiedDiffHeaderProps } from './DiffCapabilities';

/**
 * Format a timestamp as a relative time string (e.g., "2 hours ago")
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return days === 1 ? '1 day ago' : `${days} days ago`;
  }
  if (hours > 0) {
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  if (minutes > 0) {
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  }
  return 'just now';
}

export const UnifiedDiffHeader: React.FC<UnifiedDiffHeaderProps> = ({
  fileName,
  sessionInfo,
  onGoToSession,
  capabilities,
  editorType,
}) => {
  const posthog = usePostHog();
  const { changeGroups } = capabilities;
  const hasChangeGroups = changeGroups && changeGroups.count > 0;
  const hasSelection = changeGroups && changeGroups.currentIndex !== null && changeGroups.currentIndex >= 0;
  // Per-change actions are supported if explicitly set, or if the callbacks exist
  const supportsPerChangeActions = changeGroups?.supportsPerChangeActions ??
    (changeGroups?.onAcceptCurrent !== undefined && changeGroups?.onRejectCurrent !== undefined);

  const handleAcceptAll = () => {
    posthog?.capture('ai_diff_accepted', {
      acceptType: 'all',
      editorType,
    });
    capabilities.onAcceptAll();
  };

  const handleRejectAll = () => {
    posthog?.capture('ai_diff_rejected', {
      rejectType: 'all',
      editorType,
    });
    capabilities.onRejectAll();
  };

  const handleAcceptCurrent = () => {
    if (!changeGroups?.onAcceptCurrent) return;
    posthog?.capture('ai_diff_accepted', {
      acceptType: 'partial',
      editorType,
    });
    changeGroups.onAcceptCurrent();
  };

  const handleRejectCurrent = () => {
    if (!changeGroups?.onRejectCurrent) return;
    posthog?.capture('ai_diff_rejected', {
      rejectType: 'partial',
      editorType,
    });
    changeGroups.onRejectCurrent();
  };

  const handleGoToSession = () => {
    if (sessionInfo?.sessionId && onGoToSession) {
      onGoToSession(sessionInfo.sessionId);
    }
  };

  const renderSessionInfo = () => {
    if (sessionInfo?.sessionTitle) {
      const provider = sessionInfo.provider;
      const canNavigate = sessionInfo.sessionId && onGoToSession;

      const sessionLink = (
        <button
          className={`unified-diff-header-session-link flex items-center gap-1.5 py-0.5 px-1 -my-0.5 -mx-1 bg-transparent border-none rounded font-inherit text-[13px] text-[var(--nim-text)] transition-colors duration-150 min-w-0 overflow-hidden shrink ${canNavigate ? 'unified-diff-header-session-link--clickable cursor-pointer hover:bg-[var(--nim-bg-hover)]' : 'cursor-default'}`}
          onClick={canNavigate ? handleGoToSession : undefined}
          type="button"
          disabled={!canNavigate}
          title={canNavigate ? `Open "${sessionInfo.sessionTitle}" session` : undefined}
        >
          {provider ? (
            <ProviderIcon provider={provider} size={18} className="unified-diff-header-session-icon shrink-0" />
          ) : (
            <MaterialSymbol icon="smart_toy" size={18} className="unified-diff-header-session-icon shrink-0" />
          )}
          <span className="unified-diff-header-session-name font-semibold text-[var(--nim-primary)] overflow-hidden text-ellipsis whitespace-nowrap @[max-350px]/diff-header:max-w-[120px]">{sessionInfo.sessionTitle}</span>
          {canNavigate && (
            <MaterialSymbol icon="open_in_new" size={14} className="unified-diff-header-session-open-icon opacity-0 text-[var(--nim-text-faint)] transition-opacity duration-150 shrink-0 group-hover/session:opacity-100" />
          )}
        </button>
      );

      return (
        <div className="unified-diff-header-session flex items-center gap-1.5 text-[13px] text-[var(--nim-text)] min-w-0 overflow-hidden group/session">
          {sessionLink}
          {/*<span className="unified-diff-header-edit-text text-[var(--nim-text-muted)] shrink-0 @[max-550px]/diff-header:hidden">*/}
          {/*  edited {fileName || 'file'}*/}
          {/*</span>*/}
          {sessionInfo.editedAt && (
            <span className="unified-diff-header-timestamp text-[var(--nim-text-faint)] shrink-0 before:content-['\00b7'] before:mr-1.5 @[max-700px]/diff-header:hidden">
              edited {formatRelativeTime(sessionInfo.editedAt)}
            </span>
          )}
        </div>
      );
    }

    // Fallback to simple label with sparkle icon
    return (
      <span className="unified-diff-header-label flex items-center gap-2 text-[13px] font-medium text-[var(--nim-text)]">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="unified-diff-header-sparkle shrink-0">
          <path d="M8 1L9 5L13 6L9 7L8 11L7 7L3 6L7 5L8 1Z" fill="currentColor"/>
        </svg>
        AI changes to {fileName || 'file'}
      </span>
    );
  };

  return (
    <div className="unified-diff-header sticky top-0 left-0 right-0 z-[100] border-b border-[var(--nim-border)] shadow-[0_2px_4px_rgba(0,0,0,0.1)] dark:shadow-[0_2px_4px_rgba(0,0,0,0.3)] bg-[var(--nim-bg-secondary)] @container/diff-header">
      <div className="unified-diff-header-content flex items-center justify-between py-2 px-4 gap-4 min-h-[48px] @[max-450px]/diff-header:flex-wrap @[max-450px]/diff-header:py-2 @[max-450px]/diff-header:px-3 @[max-450px]/diff-header:gap-2 @[max-350px]/diff-header:py-1.5 @[max-350px]/diff-header:px-2">
        {/* Left section: Session info */}
        <div className="unified-diff-header-info flex items-center gap-3 shrink min-w-0 overflow-hidden @[max-450px]/diff-header:flex-[1_1_100%] @[max-450px]/diff-header:order-1">
          {renderSessionInfo()}
        </div>

        {/* Middle section: Navigation (only if change groups supported) */}
        {hasChangeGroups && (
          <div className="unified-diff-header-navigation flex items-center gap-2 shrink-0 @[max-450px]/diff-header:flex-[0_1_auto] @[max-450px]/diff-header:order-2">
            <button
              onClick={changeGroups.onNavigatePrevious}
              aria-label="Previous change"
              className="unified-diff-header-nav-button bg-transparent border border-[var(--nim-border)] rounded w-6 h-6 flex items-center justify-center cursor-pointer text-[var(--nim-text)] p-0 transition-colors duration-150 hover:enabled:bg-[var(--nim-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 9L3 6L6 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <span className="unified-diff-header-change-counter text-[13px] text-[var(--nim-text-muted)] min-w-[80px] text-center select-none @[max-350px]/diff-header:min-w-[60px] @[max-350px]/diff-header:text-xs">
              {hasSelection
                ? `${changeGroups.currentIndex! + 1} of ${changeGroups.count}`
                : `${changeGroups.count} changes`}
            </span>
            <button
              onClick={changeGroups.onNavigateNext}
              aria-label="Next change"
              className="unified-diff-header-nav-button bg-transparent border border-[var(--nim-border)] rounded w-6 h-6 flex items-center justify-center cursor-pointer text-[var(--nim-text)] p-0 transition-colors duration-150 hover:enabled:bg-[var(--nim-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 3L9 6L6 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        )}

        {/* Right section: Actions */}
        <div className="unified-diff-header-actions flex items-center gap-2 ml-auto shrink-0 @[max-450px]/diff-header:order-3 @[max-450px]/diff-header:gap-1.5">
          {/* Per-change buttons (only if change groups AND per-change actions supported) */}
          {hasChangeGroups && supportsPerChangeActions && (
            <>
              <button
                className="unified-diff-header-button unified-diff-header-button-reject-single py-1.5 px-3 rounded-md text-[13px] font-medium cursor-pointer transition-all duration-150 border border-[var(--nim-border)] flex items-center gap-1.5 whitespace-nowrap bg-[var(--nim-bg)] text-[var(--nim-text)] hover:enabled:bg-[var(--nim-bg-hover)] hover:enabled:opacity-100 active:enabled:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed @[max-450px]/diff-header:py-1.5 @[max-450px]/diff-header:px-2.5 @[max-350px]/diff-header:py-[5px] @[max-350px]/diff-header:px-2 @[max-350px]/diff-header:text-xs"
                onClick={handleRejectCurrent}
                title="Revert this change"
                disabled={!hasSelection}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M10 4L4 10M4 4L10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                Revert
              </button>
              <button
                className="unified-diff-header-button unified-diff-header-button-accept-single py-1.5 px-3 rounded-md text-[13px] font-medium cursor-pointer transition-all duration-150 border border-[var(--nim-primary)] flex items-center gap-1.5 whitespace-nowrap bg-[var(--nim-primary)] text-white hover:enabled:opacity-90 active:enabled:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed @[max-450px]/diff-header:py-1.5 @[max-450px]/diff-header:px-2.5 @[max-350px]/diff-header:py-[5px] @[max-350px]/diff-header:px-2 @[max-350px]/diff-header:text-xs"
                onClick={handleAcceptCurrent}
                title="Keep this change"
                disabled={!hasSelection}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M12 3L5 10L2 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Keep
              </button>
            </>
          )}
          {/* All buttons (always shown) */}
          <button
            className="unified-diff-header-button unified-diff-header-button-reject py-1.5 px-3 rounded-md text-[13px] font-medium cursor-pointer transition-all duration-150 border border-[var(--nim-border)] flex items-center gap-1.5 whitespace-nowrap bg-[var(--nim-bg)] text-[var(--nim-text)] hover:enabled:bg-[var(--nim-bg-hover)] hover:enabled:opacity-100 active:enabled:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed @[max-450px]/diff-header:py-1.5 @[max-450px]/diff-header:px-2.5 @[max-350px]/diff-header:py-[5px] @[max-350px]/diff-header:px-2 @[max-350px]/diff-header:text-xs"
            onClick={handleRejectAll}
            type="button"
            data-testid="diff-revert-all"
          >
            {hasChangeGroups && supportsPerChangeActions && (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M10 4L4 10M4 4L10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            )}
            Revert{hasChangeGroups && supportsPerChangeActions ? ' All' : ''}
          </button>
          <button
            className="unified-diff-header-button unified-diff-header-button-accept py-1.5 px-3 rounded-md text-[13px] font-medium cursor-pointer transition-all duration-150 border border-[var(--nim-primary)] flex items-center gap-1.5 whitespace-nowrap bg-[var(--nim-primary)] text-white hover:enabled:opacity-90 active:enabled:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed @[max-450px]/diff-header:py-1.5 @[max-450px]/diff-header:px-2.5 @[max-350px]/diff-header:py-[5px] @[max-350px]/diff-header:px-2 @[max-350px]/diff-header:text-xs"
            onClick={handleAcceptAll}
            type="button"
            data-testid="diff-keep-all"
          >
            {hasChangeGroups && supportsPerChangeActions && (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M12 3L5 10L2 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
            Keep{hasChangeGroups && supportsPerChangeActions ? ' All' : ''}
          </button>
        </div>
      </div>
    </div>
  );
};
