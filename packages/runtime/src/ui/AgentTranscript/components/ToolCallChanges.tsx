/**
 * ToolCallChanges - Shows pre-resolved file changes caused by a tool call.
 *
 * Renders a collapsible "File Changes" section with:
 * - Compact summary header showing file count and +/- stats
 * - DiffViewer for edit operations (old_string/new_string)
 * - NewFilePreview for create operations (full content)
 * - Compact file entry for bash/unknown operations (path + stats only)
 *
 * Diff resolution happens in main during transcript enrichment. The renderer
 * only receives the resolved `diffs` payload and renders it synchronously.
 */

import React, { useState } from 'react';
import type { ToolCallDiffResult } from './CustomToolWidgets';
import { DiffViewer } from './DiffViewer';
import { NewFilePreview } from './NewFilePreview';
import { toProjectRelative } from '../utils/pathResolver';

interface ToolCallChangesProps {
  diffs: ToolCallDiffResult[] | null | undefined;
  isExpanded: boolean;
  workspacePath?: string;
  onOpenFile?: (filePath: string) => void;
  renderEmbeddedFile?: (params: { filePath: string; defaultExpanded?: boolean }) => React.ReactNode;
  /**
   * Host-provided predicate: returns true if `filePath` will be rendered
   * by `renderEmbeddedFile` so this row can show the inline preview
   * instead of the regular diff/new-file view. The host owns the custom
   * editor registry; the runtime asks.
   */
  canEmbedFile?: (filePath: string) => boolean;
}

function getOperationBadge(operation: string): { label: string; colorClass: string; bgClass: string } {
  switch (operation) {
    case 'create':
      return {
        label: 'Created',
        colorClass: 'text-nim-success',
        bgClass: 'bg-[color-mix(in_srgb,var(--nim-success)_15%,transparent)]',
      };
    case 'delete':
      return {
        label: 'Deleted',
        colorClass: 'text-nim-error',
        bgClass: 'bg-[color-mix(in_srgb,var(--nim-error)_15%,transparent)]',
      };
    case 'bash':
      return {
        label: 'Shell',
        colorClass: 'text-nim-faint',
        bgClass: 'bg-[color-mix(in_srgb,var(--nim-text-faint)_15%,transparent)]',
      };
    default:
      return {
        label: 'Edited',
        colorClass: 'text-nim-primary',
        bgClass: 'bg-[color-mix(in_srgb,var(--nim-primary)_15%,transparent)]',
      };
  }
}

export const ToolCallChanges: React.FC<ToolCallChangesProps> = ({
  diffs,
  isExpanded,
  workspacePath,
  onOpenFile,
  renderEmbeddedFile,
  canEmbedFile,
}) => {
  const [changesExpanded, setChangesExpanded] = useState(false);

  // Don't render anything if not expanded or no diffs
  if (!isExpanded) return null;
  if (!diffs || diffs.length === 0) return null;

  // Compute summary stats
  const totalAdded = diffs.reduce((sum, d) => sum + (d.linesAdded ?? 0), 0);
  const totalRemoved = diffs.reduce((sum, d) => sum + (d.linesRemoved ?? 0), 0);
  const fileCount = diffs.length;
  const primaryFilePath = diffs[0]?.filePath;
  const primarySupportsEmbeddedPreview = !!canEmbedFile?.(diffs[0]?.filePath);
  const summaryParts = [`${fileCount} file${fileCount !== 1 ? 's' : ''} changed`];
  if (totalAdded > 0) summaryParts.push(`+${totalAdded}`);
  if (totalRemoved > 0) summaryParts.push(`-${totalRemoved}`);
  const summary = summaryParts.join(' ');

  return (
    <div className="tool-call-changes mt-2 rounded-md border border-nim overflow-hidden bg-nim-tertiary">
      {/* Header */}
      <button
        className="flex items-center justify-between w-full py-1.5 px-2 bg-nim-secondary border-b border-nim gap-2 cursor-pointer transition-colors duration-150 text-left hover:bg-nim-hover"
        onClick={() => setChangesExpanded(!changesExpanded)}
        type="button"
      >
        <div className="flex items-center gap-1.5">
          <div className="flex items-center justify-center text-nim-faint">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="12" y1="18" x2="12" y2="12"></line>
              <line x1="9" y1="15" x2="15" y2="15"></line>
            </svg>
          </div>
          <span className="text-[0.7rem] font-medium text-nim-faint uppercase tracking-wide font-sans">
            File Changes
          </span>
          <span className="text-[0.65rem] text-nim-faint font-sans">
            ({summary})
          </span>
        </div>
        <svg
          className={`text-nim-faint shrink-0 transition-transform duration-150 ${changesExpanded ? 'rotate-90' : ''}`}
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </button>

      {/* Expanded content */}
      {changesExpanded && (
        <div className="flex flex-col">
          {diffs.map((diff, idx) => {
            const relPath = toProjectRelative(diff.filePath, workspacePath);
            const badge = getOperationBadge(diff.operation);
            const hasDiffContent = diff.diffs.length > 0;
            const hasNewContent = !hasDiffContent && !!diff.content;
            const isSecondaryEmbeddableFile =
              diff.filePath !== primaryFilePath &&
              !!canEmbedFile?.(diff.filePath);
            const shouldUseEmbeddedPreview =
              !!renderEmbeddedFile &&
              primarySupportsEmbeddedPreview &&
              !!canEmbedFile?.(diff.filePath);

            if (!primarySupportsEmbeddedPreview && isSecondaryEmbeddableFile) {
              return null;
            }

            return (
              <div key={`${diff.filePath}-${idx}`} className="border-t border-nim first:border-t-0">
                {/* File header row - always shown */}
                <div className="flex items-center gap-2 py-1.5 px-2">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: `var(--nim-${diff.operation === 'create' ? 'success' : diff.operation === 'delete' ? 'error' : 'primary'})` }}
                  />
                  {onOpenFile ? (
                    <button
                      className="text-[0.75rem] text-nim-muted flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap hover:text-nim-primary hover:underline cursor-pointer bg-transparent border-none p-0 m-0 font-[inherit] text-left"
                      onClick={() => onOpenFile(diff.filePath)}
                      title={`Open ${relPath}`}
                      type="button"
                    >
                      <code>{relPath}</code>
                    </button>
                  ) : (
                    <code className="text-[0.75rem] text-nim-muted flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                      {relPath}
                    </code>
                  )}
                  {/* Line count stats */}
                  {(diff.linesAdded != null || diff.linesRemoved != null) && (
                    <span className="text-[0.65rem] text-nim-faint shrink-0 font-mono">
                      {diff.linesAdded != null && diff.linesAdded > 0 && (
                        <span className="text-nim-success">+{diff.linesAdded}</span>
                      )}
                      {diff.linesAdded != null && diff.linesAdded > 0 && diff.linesRemoved != null && diff.linesRemoved > 0 && ' '}
                      {diff.linesRemoved != null && diff.linesRemoved > 0 && (
                        <span className="text-nim-error">-{diff.linesRemoved}</span>
                      )}
                    </span>
                  )}
                  <span className={`text-[0.6rem] font-medium py-0.5 px-1.5 rounded-full ${badge.colorClass} ${badge.bgClass}`}>
                    {badge.label}
                  </span>
                  {diff.debugInfo && process.env.NODE_ENV !== 'production' && (
                    <span
                      className="text-[0.6rem] text-nim-faint shrink-0 cursor-help opacity-40 hover:opacity-100 transition-opacity"
                      title={diff.debugInfo}
                    >
                      (i)
                    </span>
                  )}
                </div>

                {/* Diff content */}
                {shouldUseEmbeddedPreview && (
                  <div className="px-2 pb-2">
                    {renderEmbeddedFile?.({ filePath: diff.filePath, defaultExpanded: diff.operation === 'create' })}
                  </div>
                )}

                {!shouldUseEmbeddedPreview && hasDiffContent && (
                  <div className="px-2 pb-2">
                    {diff.diffs.map((d, dIdx) => (
                      <DiffViewer
                        key={`diff-${dIdx}`}
                        edit={{ old_string: d.oldString, new_string: d.newString }}
                        filePath={relPath}
                        maxHeight="16rem"
                        onOpenFile={onOpenFile}
                        absoluteFilePath={diff.filePath}
                      />
                    ))}
                  </div>
                )}

                {/* New file content */}
                {!shouldUseEmbeddedPreview && hasNewContent && (
                  <div className="px-2 pb-2">
                    <NewFilePreview
                      content={diff.content!}
                      filePath={relPath}
                      maxHeight="16rem"
                      onOpenFile={onOpenFile}
                      absoluteFilePath={diff.filePath}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
