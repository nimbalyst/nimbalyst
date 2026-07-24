import React, { useMemo, useRef, useCallback, useEffect } from 'react';
import { diffLines } from 'diff';
import { generateUnifiedDiff } from '@nimbalyst/runtime';

export interface TextDiffNavigationState {
  currentIndex: number;
  totalGroups: number;
  canGoPrevious: boolean;
  canGoNext: boolean;
  addedLines: number;
  removedLines: number;
}

interface TextDiffViewerProps {
  oldText: string;
  newText: string;
  onNavigationStateChange?: (state: TextDiffNavigationState) => void;
  onNavigatePrevious?: () => void;
  onNavigateNext?: () => void;
}

interface DiffLine {
  content: string;
  type: 'added' | 'removed' | 'unchanged';
  lineNumber?: number;
}

interface ChangeGroup {
  startIndex: number;
  endIndex: number;
  type: 'addition' | 'deletion' | 'modification';
}

export function TextDiffViewer({
  oldText,
  newText,
  onNavigationStateChange,
  onNavigatePrevious,
  onNavigateNext
}: TextDiffViewerProps) {
  const oldContentRef = useRef<HTMLDivElement>(null);
  const newContentRef = useRef<HTMLDivElement>(null);
  const syncingRef = useRef(false);
  const [currentChangeIndex, setCurrentChangeIndex] = React.useState(0);
  const currentChangeIndexRef = useRef(0);
  const changeGroupsRef = useRef<ChangeGroup[]>([]);

  const { oldLines, newLines, stats, changeGroups } = useMemo(() => {
    const changes = diffLines(oldText, newText);
    const oldLines: DiffLine[] = [];
    const newLines: DiffLine[] = [];
    const changeGroups: ChangeGroup[] = [];
    let oldLineNum = 1;
    let newLineNum = 1;
    let addedLines = 0;
    let removedLines = 0;

    changes.forEach((change) => {
      const lines = change.value.split('\n');
      // Remove last empty line if present
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }

      if (change.added) {
        const startIndex = newLines.length;
        lines.forEach((line) => {
          newLines.push({ content: line, type: 'added', lineNumber: newLineNum++ });
          addedLines++;
        });
        const endIndex = newLines.length - 1;

        // Merge with previous group if it's a modification (last group was a deletion)
        if (changeGroups.length > 0 && changeGroups[changeGroups.length - 1].type === 'deletion') {
          changeGroups[changeGroups.length - 1].type = 'modification';
        } else {
          changeGroups.push({ startIndex, endIndex, type: 'addition' });
        }
      } else if (change.removed) {
        const startIndex = oldLines.length;
        lines.forEach((line) => {
          oldLines.push({ content: line, type: 'removed', lineNumber: oldLineNum++ });
          removedLines++;
        });
        const endIndex = oldLines.length - 1;
        changeGroups.push({ startIndex, endIndex, type: 'deletion' });
      } else {
        lines.forEach((line) => {
          oldLines.push({ content: line, type: 'unchanged', lineNumber: oldLineNum++ });
          newLines.push({ content: line, type: 'unchanged', lineNumber: newLineNum++ });
        });
      }
    });

    return {
      oldLines,
      newLines,
      stats: { addedLines, removedLines },
      changeGroups
    };
  }, [oldText, newText]);

  // Keep refs in sync with state
  useEffect(() => {
    currentChangeIndexRef.current = currentChangeIndex;
  }, [currentChangeIndex]);

  useEffect(() => {
    changeGroupsRef.current = changeGroups;
  }, [changeGroups]);

  const handleScroll = useCallback((source: 'old' | 'new') => {
    if (syncingRef.current) return;

    const sourceEl = source === 'old' ? oldContentRef.current : newContentRef.current;
    const targetEl = source === 'old' ? newContentRef.current : oldContentRef.current;

    if (!sourceEl || !targetEl) return;

    syncingRef.current = true;
    targetEl.scrollTop = sourceEl.scrollTop;
    targetEl.scrollLeft = sourceEl.scrollLeft;

    requestAnimationFrame(() => {
      syncingRef.current = false;
    });
  }, []);

  const handleDownloadDiff = useCallback(() => {
    try {
      const unifiedDiff = generateUnifiedDiff(oldText, newText, 'a/document.md', 'b/document.md');

      const blob = new Blob([unifiedDiff], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `diff-${Date.now()}.patch`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to generate unified diff:', error);
    }
  }, [oldText, newText]);

  const scrollToChange = useCallback((index: number) => {
    const groups = changeGroupsRef.current;
    if (index < 0 || index >= groups.length) return;

    const group = groups[index];
    const targetRef = group.type === 'addition' ? newContentRef : oldContentRef;

    if (targetRef.current) {
      const lineElements = targetRef.current.querySelectorAll('.text-diff-line');
      const targetLine = lineElements[group.startIndex];

      if (targetLine) {
        targetLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    setCurrentChangeIndex(index);

    // Update parent state immediately
    if (onNavigationStateChange) {
      onNavigationStateChange({
        currentIndex: index,
        totalGroups: groups.length,
        canGoPrevious: index > 0,
        canGoNext: index < groups.length - 1,
        addedLines: stats.addedLines,
        removedLines: stats.removedLines
      });
    }
  }, [onNavigationStateChange, stats]);

  // Handle clicks on diff lines to update navigation index
  const handleLineClick = useCallback((lineIndex: number, isNewVersion: boolean) => {
    const groups = changeGroupsRef.current;

    // Find which change group contains this line
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];

      // Check if this line is in the current group
      const isInGroup = lineIndex >= group.startIndex && lineIndex <= group.endIndex;

      // For additions, check in new version; for deletions/modifications, check in old version
      const isCorrectVersion =
        (group.type === 'addition' && isNewVersion) ||
        (group.type === 'deletion' && !isNewVersion) ||
        (group.type === 'modification' && (isNewVersion || !isNewVersion));

      if (isInGroup && isCorrectVersion) {
        if (i !== currentChangeIndexRef.current) {
          scrollToChange(i);
        }
        return;
      }
    }
  }, [scrollToChange]);

  // Notify parent of navigation state changes
  useEffect(() => {
    if (onNavigationStateChange) {
      onNavigationStateChange({
        currentIndex: currentChangeIndex,
        totalGroups: changeGroups.length,
        canGoPrevious: currentChangeIndex > 0,
        canGoNext: currentChangeIndex < changeGroups.length - 1,
        addedLines: stats.addedLines,
        removedLines: stats.removedLines
      });
    }
  }, [currentChangeIndex, changeGroups.length, stats, onNavigationStateChange]);

  // Handle navigation requests from parent
  useEffect(() => {
    if (onNavigatePrevious) {
      // Store handler so parent can trigger it
      (window as any).__textDiffNavigatePrevious = () => {
        const currentIndex = currentChangeIndexRef.current;
        const groups = changeGroupsRef.current;

        if (currentIndex > 0) {
          scrollToChange(currentIndex - 1);
        }
      };
    }
    if (onNavigateNext) {
      (window as any).__textDiffNavigateNext = () => {
        const currentIndex = currentChangeIndexRef.current;
        const groups = changeGroupsRef.current;

        if (currentIndex < groups.length - 1) {
          scrollToChange(currentIndex + 1);
        }
      };
    }
  }, [scrollToChange, onNavigatePrevious, onNavigateNext]);

  const handlePreviousChange = useCallback(() => {
    if (currentChangeIndex > 0) {
      scrollToChange(currentChangeIndex - 1);
    }
  }, [currentChangeIndex, scrollToChange]);

  const handleNextChange = useCallback(() => {
    if (currentChangeIndex < changeGroups.length - 1) {
      scrollToChange(currentChangeIndex + 1);
    }
  }, [currentChangeIndex, changeGroups.length, scrollToChange]);

  return (
    <div className="text-diff-viewer flex flex-col h-full overflow-hidden">
      <div className="text-diff-panels flex flex-1 overflow-hidden">
        <div className="text-diff-panel text-diff-old flex-1 flex flex-col overflow-hidden">
          <div className="text-diff-header px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.5px] border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-red-600">
            Old Version
          </div>
          <div
            className="text-diff-content flex-1 overflow-auto nim-scrollbar"
            ref={oldContentRef}
            onScroll={() => handleScroll('old')}
          >
            <div className="text-diff-lines font-mono text-[13px] leading-[1.6]">
              {oldLines.map((line, index) => (
                <div
                  key={index}
                  className={`text-diff-line flex min-h-[1.6em] ${
                    line.type === 'removed'
                      ? 'bg-red-100 dark:bg-red-600/15'
                      : ''
                  }`}
                  onClick={() => {
                    if (line.type !== 'unchanged') {
                      handleLineClick(index, false);
                    }
                  }}
                  style={{ cursor: line.type !== 'unchanged' ? 'pointer' : 'default' }}
                >
                  <span
                    className={`text-diff-line-number shrink-0 w-[50px] px-2 text-right select-none border-r border-[var(--nim-border)] ${
                      line.type === 'removed'
                        ? 'bg-red-200 text-red-800 dark:bg-red-600/25 dark:text-red-300'
                        : 'bg-[var(--nim-bg-secondary)] text-[var(--nim-text-faint)]'
                    }`}
                  >
                    {line.lineNumber}
                  </span>
                  <span
                    className={`text-diff-line-content flex-1 px-3 whitespace-pre-wrap break-words ${
                      line.type === 'removed'
                        ? 'text-red-800 dark:text-red-300'
                        : 'text-[var(--nim-text)]'
                    }`}
                  >
                    {line.content || ' '}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="text-diff-panel text-diff-new flex-1 flex flex-col overflow-hidden border-l border-[var(--nim-border)]">
          <div className="text-diff-header px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.5px] border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-green-600">
            New Version
          </div>
          <div
            className="text-diff-content flex-1 overflow-auto nim-scrollbar"
            ref={newContentRef}
            onScroll={() => handleScroll('new')}
          >
            <div className="text-diff-lines font-mono text-[13px] leading-[1.6]">
              {newLines.map((line, index) => (
                <div
                  key={index}
                  className={`text-diff-line flex min-h-[1.6em] ${
                    line.type === 'added'
                      ? 'bg-green-100 dark:bg-green-600/15'
                      : ''
                  }`}
                  onClick={() => {
                    if (line.type !== 'unchanged') {
                      handleLineClick(index, true);
                    }
                  }}
                  style={{ cursor: line.type !== 'unchanged' ? 'pointer' : 'default' }}
                >
                  <span
                    className={`text-diff-line-number shrink-0 w-[50px] px-2 text-right select-none border-r border-[var(--nim-border)] ${
                      line.type === 'added'
                        ? 'bg-green-200 text-green-900 dark:bg-green-600/25 dark:text-green-300'
                        : 'bg-[var(--nim-bg-secondary)] text-[var(--nim-text-faint)]'
                    }`}
                  >
                    {line.lineNumber}
                  </span>
                  <span
                    className={`text-diff-line-content flex-1 px-3 whitespace-pre-wrap break-words ${
                      line.type === 'added'
                        ? 'text-green-900 dark:text-green-300'
                        : 'text-[var(--nim-text)]'
                    }`}
                  >
                    {line.content || ' '}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
