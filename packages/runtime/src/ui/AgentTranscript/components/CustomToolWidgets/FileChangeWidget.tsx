/**
 * Custom widget for the file_change tool (Codex)
 *
 * Displays file modifications with:
 * - Compact collapsed state showing file count and names
 * - Expanded state with file list and clickable content viewer
 * - Snapshotted file contents (captured at change time)
 * - Fallback to live file reading when no snapshot is available
 */

import React, { useState, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import type { CustomToolWidgetProps } from './index';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';
import { useElapsedTimeRef } from './useElapsedTime';

/**
 * Maximum number of lines to show before adding "show more"
 */
const MAX_VISIBLE_LINES = 25;

// --- Types ---

interface FileChange {
  path: string;
  kind: string; // 'create' | 'update' | 'delete'
}

interface FileSnapshot {
  content: string | null;
  error?: string;
  isBinary?: boolean;
  truncated?: boolean;
}

// --- Helpers ---

function extractChanges(tool: any): FileChange[] {
  const args = tool?.arguments;
  const result = tool?.result;
  const changes = args?.changes || result?.changes;
  if (!Array.isArray(changes)) return [];
  return changes.filter((c: any) => c && typeof c.path === 'string');
}

function extractSnapshots(tool: any): Record<string, FileSnapshot> {
  const result = tool?.result;
  if (result && typeof result === 'object' && result.fileSnapshots) {
    return result.fileSnapshots as Record<string, FileSnapshot>;
  }
  return {};
}

function isToolRunning(tool: any): boolean {
  return tool.result === undefined || tool.result === null;
}

function isToolError(result: any, message: any): boolean {
  if (message.isError) return true;
  if (result?.success === false) return true;
  if (result?.status === 'failed') return true;
  return false;
}

function getBasename(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || filePath;
}

function getRelativePath(filePath: string, workspacePath?: string): string {
  if (!workspacePath) return filePath;
  if (filePath.startsWith(workspacePath)) {
    const relative = filePath.slice(workspacePath.length);
    return relative.startsWith('/') ? relative.slice(1) : relative;
  }
  return filePath;
}

function getKindLabel(kind: string): string {
  switch (kind) {
    case 'create': return 'Created';
    case 'delete': return 'Deleted';
    case 'update':
    default: return 'Updated';
  }
}

function getKindColorClass(kind: string): string {
  switch (kind) {
    case 'create': return 'text-nim-success';
    case 'delete': return 'text-nim-error';
    case 'update':
    default: return 'text-nim-primary';
  }
}

function getKindBgClass(kind: string): string {
  switch (kind) {
    case 'create': return 'bg-[color-mix(in_srgb,var(--nim-success)_15%,transparent)]';
    case 'delete': return 'bg-[color-mix(in_srgb,var(--nim-error)_15%,transparent)]';
    case 'update':
    default: return 'bg-[color-mix(in_srgb,var(--nim-primary)_15%,transparent)]';
  }
}

function getSummary(changes: FileChange[]): string {
  if (changes.length === 0) return 'No file changes';
  if (changes.length === 1) {
    const c = changes[0];
    return `${getKindLabel(c.kind)} ${getBasename(c.path)}`;
  }
  // Check if all same kind
  const kinds = new Set(changes.map(c => c.kind));
  if (kinds.size === 1) {
    const kind = changes[0].kind;
    return `${getKindLabel(kind)} ${changes.length} files`;
  }
  return `Changed ${changes.length} files`;
}

function countLines(text: string): number {
  return text.split('\n').length;
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n');
}

// --- Component ---

export const FileChangeWidget: React.FC<CustomToolWidgetProps> = ({
  message,
  isExpanded,
  onToggle,
  workspacePath,
  readFile,
  sessionId,
}) => {
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [contentExpanded, setContentExpanded] = useState(false);
  const [liveContent, setLiveContent] = useState<Record<string, { content: string | null; error?: string }>>({});
  const [loadingLive, setLoadingLive] = useState<Set<string>>(new Set());

  const tool = message.toolCall;
  const running = tool ? isToolRunning(tool) : false;
  const elapsedRef = useElapsedTimeRef(running ? message.createdAt.getTime() : undefined);

  if (!tool) return null;

  const changes = extractChanges(tool);
  const snapshots = extractSnapshots(tool);
  const hasError = isToolError(tool.result, message);

  const handleFileClick = useCallback(async (filePath: string) => {
    if (selectedFile === filePath) {
      setSelectedFile(null);
      setContentExpanded(false);
      return;
    }
    setSelectedFile(filePath);
    setContentExpanded(false);

    // If no snapshot available (e.g. older messages), try live read from disk
    const snapshot = snapshots[filePath];
    const hasNoSnapshot = !snapshot; // No snapshot entry at all
    const needsLiveRead = hasNoSnapshot && readFile && !liveContent[filePath];
    if (needsLiveRead) {
      setLoadingLive(prev => new Set(prev).add(filePath));
      try {
        const result = await readFile(filePath);
        setLiveContent(prev => ({
          ...prev,
          [filePath]: { content: result.success ? result.content ?? null : null, error: result.success ? undefined : result.error },
        }));
      } catch {
        setLiveContent(prev => ({ ...prev, [filePath]: { content: null, error: 'Failed to read file' } }));
      } finally {
        setLoadingLive(prev => {
          const next = new Set(prev);
          next.delete(filePath);
          return next;
        });
      }
    }
  }, [selectedFile, snapshots, readFile, liveContent]);

  const handlePathClick = useCallback((e: React.MouseEvent, filePath: string) => {
    e.stopPropagation();
    if (host) {
      host.openFile(filePath);
    }
  }, [host]);

  const getBorderClass = () => {
    if (hasError) return 'border-[color-mix(in_srgb,var(--nim-error)_40%,var(--nim-border))]';
    if (running) return 'border-[color-mix(in_srgb,var(--nim-primary)_40%,var(--nim-border))]';
    return 'border-nim';
  };

  // --- Collapsed view ---
  if (!isExpanded) {
    const summary = getSummary(changes);
    return (
      <button
        className={`file-change-widget rounded-md bg-nim-tertiary ${getBorderClass()} border overflow-hidden flex items-center justify-between w-full py-1.5 px-2 cursor-pointer transition-colors duration-150 text-left hover:bg-nim-hover`}
        onClick={onToggle}
        type="button"
      >
        <div className="flex items-start gap-1.5 min-w-0 flex-1 overflow-hidden">
          <div className="flex items-center justify-center shrink-0 text-nim-faint mt-0.5">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="12" y1="18" x2="12" y2="12"></line>
              <line x1="9" y1="15" x2="15" y2="15"></line>
            </svg>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0 flex-1 overflow-hidden">
            <span className="text-xs text-nim-muted font-sans whitespace-nowrap overflow-hidden text-ellipsis">{summary}</span>
            {changes.length > 1 && (
              <code className="text-[0.7rem] text-nim-faint whitespace-nowrap overflow-hidden text-ellipsis">
                {changes.map(c => getBasename(c.path)).join(', ')}
              </code>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {running && (
            <span className="flex items-center gap-1 text-[0.7rem] font-medium font-sans text-nim-primary">
              <span className="w-2.5 h-2.5 border-[1.5px] border-[color-mix(in_srgb,var(--nim-primary)_30%,transparent)] border-t-nim-primary rounded-full animate-spin" />
              <span ref={elapsedRef} className="tabular-nums" />
            </span>
          )}
          {!running && !hasError && (
            <span className="flex items-center text-nim-success">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </span>
          )}
          {!running && hasError && (
            <span className="flex items-center text-nim-error">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </span>
          )}
          <svg className="text-nim-faint shrink-0 transition-transform duration-150" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </div>
      </button>
    );
  }

  // --- Expanded view ---

  // Resolve content for selected file
  let selectedContent: string | null = null;
  let selectedIsBinary = false;
  let selectedTruncated = false;
  let selectedError: string | undefined;
  let selectedIsLive = false;
  let selectedIsLoading = false;

  if (selectedFile) {
    const snapshot = snapshots[selectedFile];
    if (snapshot) {
      selectedContent = snapshot.content;
      selectedIsBinary = !!snapshot.isBinary;
      selectedTruncated = !!snapshot.truncated;
      selectedError = snapshot.error;
    } else if (liveContent[selectedFile]) {
      selectedContent = liveContent[selectedFile].content;
      selectedError = liveContent[selectedFile].error;
      selectedIsLive = true;
    }
    selectedIsLoading = loadingLive.has(selectedFile);
  }

  const selectedChange = selectedFile ? changes.find(c => c.path === selectedFile) : null;
  const lineCount = selectedContent ? countLines(selectedContent) : 0;
  const needsTruncation = lineCount > MAX_VISIBLE_LINES;
  const displayContent = selectedContent && needsTruncation && !contentExpanded
    ? truncateLines(selectedContent, MAX_VISIBLE_LINES)
    : selectedContent;
  const hiddenLineCount = lineCount - MAX_VISIBLE_LINES;

  return (
    <div className={`file-change-widget rounded-md bg-nim-tertiary ${getBorderClass()} border overflow-hidden`}>
      {/* Header */}
      <button
        className="flex items-center justify-between w-full py-1.5 px-2 bg-nim-secondary border-b border-nim gap-2 cursor-pointer transition-colors duration-150 text-left hover:bg-nim-hover"
        onClick={onToggle}
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
          <span className="text-[0.7rem] font-medium text-nim-faint uppercase tracking-wide font-sans">File Changes</span>
        </div>
        <div className="flex items-center gap-1.5">
          {running && (
            <span className="flex items-center gap-1 text-[0.7rem] font-medium font-sans text-nim-primary">
              <span className="w-2.5 h-2.5 border-[1.5px] border-[color-mix(in_srgb,var(--nim-primary)_30%,transparent)] border-t-nim-primary rounded-full animate-spin" />
              Running <span ref={elapsedRef} className="tabular-nums" />
            </span>
          )}
          {!running && !hasError && (
            <span className="flex items-center text-nim-success">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </span>
          )}
          {!running && hasError && (
            <span className="flex items-center text-nim-error">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </span>
          )}
          <svg className="text-nim-faint shrink-0 transition-transform duration-150" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
      </button>

      {/* File list */}
      <div className="divide-y divide-nim">
        {changes.map((change, i) => {
          const relPath = getRelativePath(change.path, workspacePath);
          const isSelected = selectedFile === change.path;
          return (
            <button
              key={change.path + i}
              className={`flex items-center gap-2 w-full py-1.5 px-2 text-left cursor-pointer transition-colors duration-150 hover:bg-nim-hover ${isSelected ? 'bg-nim-hover' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                handleFileClick(change.path);
              }}
              type="button"
            >
              {/* Kind dot */}
              <span className={`w-2 h-2 rounded-full shrink-0 ${getKindBgClass(change.kind)} ${getKindColorClass(change.kind)}`}
                style={{ backgroundColor: `var(--nim-${change.kind === 'create' ? 'success' : change.kind === 'delete' ? 'error' : 'primary'})` }}
              />
              {/* File path - clickable to open in editor */}
              <code
                className="text-[0.75rem] text-nim-muted flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap hover:text-nim-primary hover:underline cursor-pointer"
                onClick={(e) => handlePathClick(e, change.path)}
                title={`Open ${relPath}`}
              >
                {relPath}
              </code>
              {/* Kind badge */}
              <span className={`text-[0.65rem] font-medium py-0.5 px-1.5 rounded-full ${getKindColorClass(change.kind)} ${getKindBgClass(change.kind)}`}>
                {getKindLabel(change.kind)}
              </span>
              {/* Expand indicator */}
              <svg
                className={`text-nim-faint shrink-0 transition-transform duration-150 ${isSelected ? 'rotate-90' : ''}`}
                width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <polyline points="9 18 15 12 9 6"></polyline>
              </svg>
            </button>
          );
        })}
      </div>

      {/* Selected file content */}
      {selectedFile && (
        <div className="border-t border-nim">
          {/* Loading state */}
          {selectedIsLoading && (
            <div className="flex items-center justify-center py-3 bg-nim">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-nim-faint rounded-full animate-bash-dot-pulse" style={{ animationDelay: '0s' }}></span>
                <span className="w-1.5 h-1.5 bg-nim-faint rounded-full animate-bash-dot-pulse" style={{ animationDelay: '0.2s' }}></span>
                <span className="w-1.5 h-1.5 bg-nim-faint rounded-full animate-bash-dot-pulse" style={{ animationDelay: '0.4s' }}></span>
              </span>
            </div>
          )}

          {/* Binary file */}
          {!selectedIsLoading && selectedIsBinary && (
            <div className="py-2 px-3 text-xs text-nim-faint font-sans italic bg-nim">
              Binary file - content cannot be displayed
            </div>
          )}

          {/* Deleted file */}
          {!selectedIsLoading && !selectedIsBinary && selectedChange?.kind === 'delete' && !selectedContent && (
            <div className="py-2 px-3 text-xs text-nim-faint font-sans italic bg-nim">
              File was deleted
            </div>
          )}

          {/* Error */}
          {!selectedIsLoading && selectedError && !selectedContent && (
            <div className="py-2 px-3 text-xs text-nim-error font-sans bg-nim">
              {selectedError}
            </div>
          )}

          {/* No snapshot, no live content, not loading */}
          {!selectedIsLoading && !selectedContent && !selectedIsBinary && !selectedError && selectedChange?.kind !== 'delete' && (
            <div className="py-2 px-3 text-xs text-nim-faint font-sans italic bg-nim">
              Snapshot unavailable
            </div>
          )}

          {/* File content */}
          {!selectedIsLoading && displayContent && (
            <div className="relative">
              {selectedIsLive && (
                <div className="py-1 px-3 text-[0.65rem] text-nim-faint font-sans bg-nim-secondary border-b border-nim">
                  Showing current file (no snapshot available)
                </div>
              )}
              {selectedTruncated && (
                <div className="py-1 px-3 text-[0.65rem] text-nim-faint font-sans bg-nim-secondary border-b border-nim">
                  File truncated at 100KB
                </div>
              )}
              <pre className="m-0 p-2 text-xs leading-normal text-nim-muted bg-nim overflow-x-auto whitespace-pre-wrap break-words max-h-80 overflow-y-auto font-mono">
                {displayContent}
              </pre>
              {needsTruncation && (
                <button
                  className="block w-full py-1.5 px-2 bg-nim-secondary border-t border-nim text-nim-faint text-[0.7rem] font-sans cursor-pointer text-center transition-all duration-150 hover:bg-nim-hover hover:text-nim-muted"
                  onClick={() => setContentExpanded(!contentExpanded)}
                  type="button"
                >
                  {contentExpanded
                    ? 'Show less'
                    : `Show ${hiddenLineCount} more line${hiddenLineCount === 1 ? '' : 's'}`
                  }
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Running indicator with no changes yet */}
      {running && changes.length === 0 && (
        <div className="flex items-center justify-center py-3 border-t border-nim bg-nim">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 bg-nim-faint rounded-full animate-bash-dot-pulse" style={{ animationDelay: '0s' }}></span>
            <span className="w-1.5 h-1.5 bg-nim-faint rounded-full animate-bash-dot-pulse" style={{ animationDelay: '0.2s' }}></span>
            <span className="w-1.5 h-1.5 bg-nim-faint rounded-full animate-bash-dot-pulse" style={{ animationDelay: '0.4s' }}></span>
          </span>
        </div>
      )}
    </div>
  );
};
