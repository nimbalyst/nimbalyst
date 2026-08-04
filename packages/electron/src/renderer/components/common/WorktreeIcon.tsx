import React from 'react';

/**
 * Git-branching glyph used wherever a worktree is represented (session sidebar
 * groups and flat items, blitz groups, the kanban board, the Agent mode header).
 *
 * Material Symbols has no glyph that reads as "worktree" rather than "branch",
 * so this is a hand-drawn SVG. It was previously copy-pasted into every call
 * site; edit it here.
 */
export const WorktreeIcon: React.FC<{ size?: number; className?: string }> = ({ size = 16, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <rect x="3" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    <rect x="10" y="2" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    <rect x="3" y="11" width="3" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    <path d="M4.5 5v3.5a1.5 1.5 0 0 0 1.5 1.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M11.5 5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
