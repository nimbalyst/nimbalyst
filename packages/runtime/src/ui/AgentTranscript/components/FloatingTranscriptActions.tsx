/**
 * FloatingTranscriptActions - Floating action buttons for AgentTranscriptPanel
 *
 * Provides two floating buttons in the top-right corner of the transcript:
 * 1. Prompts menu (TOC icon) - Dropdown showing all user prompts in the session
 * 2. Toggle history button - Shows/hides the file history sidebar
 *
 * This component follows the same design pattern as FloatingDocumentActionsPlugin
 * in the TabEditor, with consistent styling, positioning, and interaction patterns.
 */
import React, { useState, useMemo } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import type { PromptMarker } from '../types';
import { formatShortTime } from '../../../utils/dateUtils';
import { MaterialSymbol } from '../../icons/MaterialSymbol';
const tableOfContentsIconUrl = new URL('../../../images/icons/table-of-contents.svg', import.meta.url).href;

// =============================================================================
// PromptsMenuButton - Standalone prompts menu dropdown
// =============================================================================

interface PromptsMenuButtonProps {
  prompts: PromptMarker[];
  onNavigateToPrompt: (marker: PromptMarker) => void;
  /** Optional class name for the container */
  className?: string;
  /** Optional class name for the button */
  buttonClassName?: string;
}

/**
 * Standalone prompts menu button with dropdown.
 * Can be used independently (e.g., in mobile header) or as part of FloatingTranscriptActions.
 */
export const PromptsMenuButton: React.FC<PromptsMenuButtonProps> = ({
  prompts,
  onNavigateToPrompt,
  className,
  buttonClassName,
}) => {
  const [showMenu, setShowMenu] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open: showMenu,
    onOpenChange: setShowMenu,
    placement: 'bottom-end',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({ fallbackPlacements: ['top-end', 'bottom-start', 'top-start'], padding: 8 }),
      shift({ padding: 8 }),
    ],
  });
  const dismiss = useDismiss(context, {
    outsidePress: true,
    escapeKey: true,
  });
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

  // Handle prompt selection
  const handlePromptClick = (marker: PromptMarker) => {
    onNavigateToPrompt(marker);
    setShowMenu(false);
  };

  // Truncate prompt text for display
  const truncatePrompt = (text: string, maxLength: number = 80): string => {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  };

  const dropdownContent = showMenu ? (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className="floating-transcript-prompts-dropdown min-w-80 max-w-[480px] max-h-[min(500px,calc(100vh-24px))] overflow-y-auto bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-lg z-[1000] pointer-events-auto"
        {...getFloatingProps()}
      >
        {prompts.length > 0 ? (
          <ul className="prompts-list list-none m-0 py-1 px-0">
            {prompts.map((prompt) => (
              <li
                key={prompt.id}
                className="prompts-item flex items-start gap-2 px-3 py-2.5 cursor-pointer transition-colors border-b border-[var(--nim-border)] last:border-b-0 hover:bg-[var(--nim-bg-hover)]"
                onClick={() => handlePromptClick(prompt)}
                title={prompt.promptText}
              >
                <div className="prompts-item-number text-[var(--nim-text-faint)] text-[11px] font-semibold min-w-8 text-right pt-0.5">#{prompt.id}</div>
                <div className="prompts-item-text flex-1 text-[var(--nim-text)] text-[13px] leading-snug overflow-hidden text-ellipsis line-clamp-2">
                  {truncatePrompt(prompt.promptText)}
                </div>
                <div className="prompts-item-timestamp text-[var(--nim-text-faint)] text-[11px] whitespace-nowrap pt-0.5">
                  {formatShortTime(prompt.timestamp)}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="prompts-empty py-6 px-4 text-center text-[var(--nim-text-faint)] text-[13px]">No prompts in this session</div>
        )}
      </div>
    </FloatingPortal>
  ) : null;

  return (
    <div className={className || 'prompts-menu-container inline-flex'}>
      <button
        ref={refs.setReference}
        className={buttonClassName || 'floating-transcript-button pointer-events-auto w-9 h-9 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] cursor-pointer flex items-center justify-center transition-all relative shadow-sm hover:bg-[var(--nim-bg-tertiary)] active:scale-95'}
        aria-label="Prompts Menu"
        aria-expanded={showMenu}
        title="Show prompts in this session"
        {...getReferenceProps({
          onClick: () => setShowMenu(open => !open),
        })}
      >
        {/* Table of contents icon */}
        <i
          className="icon table-of-contents w-5 h-5 bg-contain bg-no-repeat dark:invert"
          style={{ backgroundImage: `url(${tableOfContentsIconUrl})` }}
        />
        {prompts.length > 0 && (
          <span className="prompts-badge absolute -top-1 -right-1 bg-[var(--nim-primary)] text-white text-[10px] font-semibold px-1.5 py-0.5 rounded-full min-w-[18px] text-center leading-none shadow-sm">{prompts.length}</span>
        )}
      </button>
      {dropdownContent}
    </div>
  );
};

// =============================================================================
// FloatingTranscriptActions - Container with prompts menu + history toggle
// =============================================================================

/** Phase column definition for the kanban board */
export interface PhaseColumn {
  value: string;
  label: string;
  color: string;
}

interface FloatingTranscriptActionsProps {
  prompts: PromptMarker[];
  /** Whether the sidebar is collapsed (only used if onToggleSidebar is provided) */
  isSidebarCollapsed?: boolean;
  /** Optional: Toggle sidebar visibility. If not provided, the toggle button is hidden. */
  onToggleSidebar?: () => void;
  onNavigateToPrompt: (marker: PromptMarker) => void;
  /** Current session phase for the kanban board */
  currentPhase?: string | null;
  /** Available phase columns */
  phaseColumns?: PhaseColumn[];
  /** Callback when phase is changed. If not provided, the phase button is hidden. */
  onSetPhase?: (phase: string | null) => void;
  /**
   * Whether the transcript find-in-page search bar is currently visible.
   * The search bar is a `sticky top-0` element occupying ~44px at the top of
   * the same container these floating actions sit in. When it is visible,
   * shift the actions down so the phase pill no longer overlaps the search
   * bar's right-side controls on narrow widths. See #309.
   */
  searchBarVisible?: boolean;
}

export const FloatingTranscriptActions: React.FC<FloatingTranscriptActionsProps> = ({
  prompts,
  isSidebarCollapsed,
  onToggleSidebar,
  onNavigateToPrompt,
  currentPhase,
  phaseColumns,
  onSetPhase,
  searchBarVisible = false,
}) => {
  const [showPhaseMenu, setShowPhaseMenu] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open: showPhaseMenu,
    onOpenChange: setShowPhaseMenu,
    placement: 'bottom-end',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(8),
      flip({ fallbackPlacements: ['top-end', 'bottom-start', 'top-start'], padding: 8 }),
      shift({ padding: 8 }),
    ],
  });
  const dismiss = useDismiss(context, {
    outsidePress: true,
    escapeKey: true,
  });
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

  const currentPhaseCol = phaseColumns?.find(c => c.value === currentPhase);
  const phaseMenu = useMemo(() => {
    if (!showPhaseMenu || !phaseColumns) return null;

    return (
      <FloatingPortal>
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className="min-w-[160px] max-h-[min(320px,calc(100vh-24px))] overflow-y-auto p-1 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md shadow-lg z-[1000] pointer-events-auto outline-none"
          {...getFloatingProps()}
        >
          {phaseColumns.map((col) => (
            <button
              key={col.value}
              className={`flex items-center gap-2 w-full px-2.5 py-2 bg-transparent border-none rounded text-[0.8125rem] cursor-pointer text-left transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] ${currentPhase === col.value ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text)]'}`}
              onClick={() => {
                onSetPhase?.(col.value);
                setShowPhaseMenu(false);
              }}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color }} />
              {col.label}
              {currentPhase === col.value && <MaterialSymbol icon="check" size={14} className="ml-auto" />}
            </button>
          ))}
          {currentPhase && (
            <>
              <div className="h-px bg-[var(--nim-border)] my-1" />
              <button
                className="flex items-center gap-2 w-full px-2.5 py-2 bg-transparent border-none rounded text-[var(--nim-text-faint)] text-[0.8125rem] cursor-pointer text-left transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
                onClick={() => {
                  onSetPhase?.(null);
                  setShowPhaseMenu(false);
                }}
              >
                <MaterialSymbol icon="close" size={14} />
                Remove from board
              </button>
            </>
          )}
        </div>
      </FloatingPortal>
    );
  }, [currentPhase, floatingStyles, getFloatingProps, onSetPhase, phaseColumns, refs.setFloating, showPhaseMenu]);

  return (
    <div
      className={`floating-transcript-actions absolute right-3 flex gap-2 z-[100] pointer-events-none transition-all duration-150 ${
        searchBarVisible ? 'top-14' : 'top-1.5'
      }`}
    >
      {/* Phase Picker Button */}
      {onSetPhase && phaseColumns && (
        <div className="inline-flex">
          <button
            ref={refs.setReference}
            className="floating-transcript-button pointer-events-auto h-9 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] cursor-pointer flex items-center gap-1.5 px-2.5 transition-all relative shadow-sm hover:bg-[var(--nim-bg-tertiary)] active:scale-95 text-[12px]"
            aria-label="Set phase"
            aria-expanded={showPhaseMenu}
            title={currentPhase ? `Phase: ${currentPhaseCol?.label || currentPhase}` : 'Set kanban phase'}
            {...getReferenceProps({
              onClick: () => setShowPhaseMenu(open => !open),
            })}
          >
            {currentPhaseCol ? (
              <>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: currentPhaseCol.color }} />
                <span>{currentPhaseCol.label}</span>
              </>
            ) : (
              <>
                <MaterialSymbol icon="view_kanban" size={16} />
                <span className="text-[var(--nim-text-faint)]">Phase</span>
              </>
            )}
          </button>
        </div>
      )}
      {phaseMenu}

      {/* Prompts Menu Button */}
      <PromptsMenuButton
        prompts={prompts}
        onNavigateToPrompt={onNavigateToPrompt}
      />

      {/* Toggle History Button - only shown if onToggleSidebar is provided */}
      {onToggleSidebar && (
        <button
          className="floating-transcript-button pointer-events-auto w-9 h-9 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] cursor-pointer flex items-center justify-center transition-all relative shadow-sm hover:bg-[var(--nim-bg-tertiary)] active:scale-95"
          onClick={onToggleSidebar}
          aria-label={isSidebarCollapsed ? 'Show file history' : 'Hide file history'}
          title={isSidebarCollapsed ? 'Show file history' : 'Hide file history'}
        >
          {isSidebarCollapsed ? (
            <MaterialSymbol icon="schedule" size={20} />
          ) : (
            <MaterialSymbol icon="chevron_right" size={20} />
          )}
        </button>
      )}
    </div>
  );
};
