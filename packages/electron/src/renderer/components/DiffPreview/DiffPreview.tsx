import React, { useMemo } from 'react';
import { diffLines, diffWords, Change } from 'diff';

interface DiffPreviewProps {
  original: string;
  modified: string;
  onAccept: () => void;
  onReject: () => void;
  title?: string;
}

export function DiffPreview({ original, modified, onAccept, onReject, title }: DiffPreviewProps) {
  const changes = useMemo(() => {
    // Use line diff for longer content, word diff for shorter
    if (original.length > 500 || modified.length > 500) {
      return diffLines(original, modified);
    } else {
      return diffWords(original, modified);
    }
  }, [original, modified]);

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;

    changes.forEach(change => {
      if (change.added) {
        added += change.value.length;
      } else if (change.removed) {
        removed += change.value.length;
      }
    });

    return { added, removed };
  }, [changes]);

  return (
    <div className="diff-preview nim-panel my-3">
      <div className="diff-header nim-panel-header">
        <h3 className="m-0 text-sm font-semibold text-[var(--nim-text)]">{title || 'Proposed Changes'}</h3>
        <div className="diff-stats flex gap-3 text-xs font-mono">
          <span className="diff-stat-added text-green-500">+{stats.added}</span>
          <span className="diff-stat-removed text-red-500">-{stats.removed}</span>
        </div>
      </div>

      <div className="diff-content nim-scrollbar p-4 max-h-[400px] overflow-y-auto font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words">
        {changes.map((change: Change, index: number) => {
          if (change.added) {
            return (
              <span key={index} className="diff-added bg-green-500/15 text-green-500 no-underline py-0.5">
                {change.value}
              </span>
            );
          } else if (change.removed) {
            return (
              <span key={index} className="diff-removed bg-red-500/15 text-red-500 line-through py-0.5">
                {change.value}
              </span>
            );
          } else {
            return (
              <span key={index} className="diff-unchanged text-[var(--nim-text)] opacity-70">
                {change.value}
              </span>
            );
          }
        })}
      </div>

      <div className="diff-actions flex gap-3 px-4 py-3 border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)]">
        <button className="diff-action-accept flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 border-none bg-green-500 text-white hover:bg-green-600" onClick={onAccept}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Accept Changes
        </button>
        <button className="diff-action-reject flex items-center gap-1.5 px-4 py-2 rounded-md text-[13px] font-medium cursor-pointer transition-all duration-200 bg-transparent text-[var(--nim-text-muted)] border border-[var(--nim-border)] hover:bg-[var(--nim-bg-tertiary)] hover:text-[var(--nim-text)]" onClick={onReject}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M12 4L4 12M4 4L12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Reject
        </button>
      </div>
    </div>
  );
}