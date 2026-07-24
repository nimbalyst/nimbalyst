/**
 * LayoutControls - Toggle buttons for session editor layout modes
 *
 * Provides three buttons to control the split view:
 * - Maximize editor (hide transcript)
 * - Split view (both visible)
 * - Maximize transcript (hide editor)
 */

import React from 'react';
import type { SessionLayoutMode } from '../../store';
import { HelpTooltip } from '../../help';

// Custom SVG icons for layout modes
// Each shows a panel with a divider line indicating where the split is

/** Editor maximized - divider near bottom */
const EditorMaxIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    <line x1="3" y1="12" x2="13" y2="12" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

/** Split view - divider in middle */
const SplitViewIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

/** Transcript maximized - divider near top */
const TranscriptMaxIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    <line x1="3" y1="4" x2="13" y2="4" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

interface LayoutControlsProps {
  mode: SessionLayoutMode;
  hasTabs: boolean;
  onModeChange: (mode: SessionLayoutMode) => void;
}

export function LayoutControls({ mode, hasTabs, onModeChange }: LayoutControlsProps) {
  return (
    <HelpTooltip testId="layout-controls">
      <div className="layout-controls flex items-center gap-0.5 p-1 bg-nim-tertiary rounded-md" data-testid="layout-controls">
        <button
          className={`layout-control-btn with-label flex items-center justify-center gap-1 w-auto h-6 px-2 py-0 border-none rounded cursor-pointer transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${mode === 'editor' ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:enabled:bg-nim-hover hover:enabled:text-nim'}`}
          onClick={() => onModeChange('editor')}
          aria-label="Maximize editor"
          disabled={!hasTabs}
          data-testid="layout-maximize-editor"
        >
          <span className="layout-label text-[11px] font-medium uppercase tracking-[0.02em]">Files</span>
          <EditorMaxIcon />
        </button>
        <button
          className={`layout-control-btn flex items-center justify-center w-7 h-6 p-0 border-none rounded cursor-pointer transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${mode === 'split' ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:enabled:bg-nim-hover hover:enabled:text-nim'}`}
          onClick={() => onModeChange('split')}
          aria-label="Split view"
          disabled={!hasTabs}
          data-testid="layout-split-view"
        >
          <SplitViewIcon />
        </button>
        <button
          className={`layout-control-btn with-label flex items-center justify-center gap-1 w-auto h-6 px-2 py-0 border-none rounded cursor-pointer transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${mode === 'transcript' ? 'active bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover' : 'bg-transparent text-nim-muted hover:enabled:bg-nim-hover hover:enabled:text-nim'}`}
          onClick={() => onModeChange('transcript')}
          aria-label="Maximize transcript"
          data-testid="layout-maximize-transcript"
        >
          <TranscriptMaxIcon />
          <span className="layout-label text-[11px] font-medium uppercase tracking-[0.02em]">Agent</span>
        </button>
      </div>
    </HelpTooltip>
  );
}

export default LayoutControls;
