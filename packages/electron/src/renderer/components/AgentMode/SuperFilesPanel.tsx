/**
 * SuperFilesPanel - Shows Super Loop progress and .superloop/ files for a worktree.
 *
 * Since .superloop/ is gitignored, these files don't appear in the uncommitted files view.
 * This panel surfaces the loop's progress (phase, iteration, learnings, blockers)
 * and provides clickable links to open the .superloop/ files directly.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  superProgressAtom,
  setSuperProgressAtom,
} from '../../store/atoms/superLoop';
import type { SuperLoop } from '../../../shared/types/superLoop';

interface SuperFilesPanelProps {
  worktreeId: string;
  worktreePath: string;
  onFileClick: (filePath: string) => void;
}

const SUPER_LOOP_FILES = [
  { name: 'IMPLEMENTATION_PLAN.md', icon: 'description' as const, label: 'Plan' },
  { name: 'task.md', icon: 'task' as const, label: 'Task' },
  { name: 'progress.json', icon: 'monitoring' as const, label: 'Progress' },
  { name: 'config.json', icon: 'settings' as const, label: 'Config' },
];

export const SuperFilesPanel: React.FC<SuperFilesPanelProps> = React.memo(({
  worktreeId,
  worktreePath,
  onFileClick,
}) => {
  const [loop, setLoop] = useState<SuperLoop | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const progress = useAtomValue(superProgressAtom(loop?.id ?? ''));
  const setProgress = useSetAtom(setSuperProgressAtom);

  // Load the super loop for this worktree
  useEffect(() => {
    let cancelled = false;

    async function loadLoop() {
      try {
        const result = await window.electronAPI.invoke('super-loop:get-by-worktree', worktreeId);
        if (!cancelled && result.success && result.loop) {
          setLoop(result.loop);
        }
      } catch (error) {
        console.error('[SuperFilesPanel] Failed to load super loop:', error);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadLoop();
    return () => { cancelled = true; };
  }, [worktreeId]);

  // Load progress data when loop is available
  useEffect(() => {
    if (!loop) return;
    const loopId = loop.id;
    let cancelled = false;

    async function loadProgress() {
      // Only fetch if not already cached in the atom
      if (progress) return;

      try {
        const result = await window.electronAPI.invoke('super-loop:get-progress', loopId);
        if (!cancelled && result.success && result.progress) {
          setProgress({ loopId, progress: result.progress });
        }
      } catch (error) {
        console.error('[SuperFilesPanel] Failed to load progress:', error);
      }
    }

    loadProgress();
    return () => { cancelled = true; };
  }, [loop, progress, setProgress]);

  const handleToggle = useCallback(() => {
    setIsCollapsed(prev => !prev);
  }, []);

  const handleFileClick = useCallback((fileName: string) => {
    const filePath = `${worktreePath}/.superloop/${fileName}`;
    onFileClick(filePath);
  }, [worktreePath, onFileClick]);

  // Don't render if loading or no loop exists
  if (isLoading || !loop) {
    return null;
  }

  const recentLearnings = progress?.learnings?.slice(-3) ?? [];
  const blockers = progress?.blockers ?? [];
  const phase = progress?.phase ?? loop.status;
  const currentIteration = progress?.currentIteration ?? loop.currentIteration;

  return (
    <div className="flex flex-col gap-2 pt-3 border-t border-[var(--nim-border)]">
      {/* Section header */}
      <button
        className="flex items-center gap-2 w-full bg-transparent border-none cursor-pointer text-left p-0 hover:opacity-80"
        onClick={handleToggle}
      >
        <MaterialSymbol
          icon={isCollapsed ? 'chevron_right' : 'expand_more'}
          size={14}
          className="text-[var(--nim-text-muted)] shrink-0"
        />
        <MaterialSymbol
          icon="sync"
          size={14}
          className="text-[var(--nim-text-muted)] shrink-0"
        />
        <span className="text-[11px] font-semibold text-[var(--nim-text)]">
          Loop Progress
        </span>
        <PhaseBadge phase={phase} />
        <span className="ml-auto text-[10px] text-[var(--nim-text-muted)] font-mono">
          {currentIteration}/{loop.maxIterations}
        </span>
      </button>

      {/* Expanded content */}
      {!isCollapsed && (
        <div className="flex flex-col gap-2 pl-5">
          {/* Blockers */}
          {blockers.length > 0 && (
            <div className="flex flex-col gap-1">
              {blockers.map((blocker, i) => (
                <div
                  key={i}
                  className="flex items-start gap-1.5 text-[10px] text-[var(--nim-warning)] leading-[1.4]"
                >
                  <MaterialSymbol icon="warning" size={12} className="shrink-0 mt-0.5" />
                  <span>{blocker}</span>
                </div>
              ))}
            </div>
          )}

          {/* Recent learnings */}
          {recentLearnings.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-[var(--nim-text-muted)]">Recent</span>
              {recentLearnings.map((learning, i) => (
                <div
                  key={i}
                  className="flex items-start gap-1.5 text-[10px] text-[var(--nim-text)] leading-[1.4]"
                >
                  <span className="text-[var(--nim-text-faint)] font-mono shrink-0">
                    #{learning.iteration}
                  </span>
                  <span className="break-words">{learning.summary}</span>
                </div>
              ))}
            </div>
          )}

          {/* File links */}
          <div className="flex flex-wrap gap-1 pt-1">
            {SUPER_LOOP_FILES.map((file) => (
              <button
                key={file.name}
                className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-[var(--nim-primary)] bg-transparent border border-[var(--nim-border)] rounded cursor-pointer hover:bg-[var(--nim-bg-hover)] transition-colors"
                onClick={() => handleFileClick(file.name)}
                title={`.superloop/${file.name}`}
              >
                <MaterialSymbol icon={file.icon} size={12} />
                <span>{file.label}</span>
              </button>
            ))}
          </div>

          {/* Raw JSON view */}
          {progress && (
            <details className="text-[10px] pt-1">
              <summary className="text-[var(--nim-text-muted)] cursor-pointer py-1 hover:text-[var(--nim-text)] list-none flex items-center gap-1">
                <MaterialSymbol icon="data_object" size={12} className="shrink-0" />
                <span>Raw JSON</span>
              </summary>
              <pre className="mt-1 p-2 bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] rounded text-[10px] leading-relaxed text-[var(--nim-text-muted)] overflow-auto max-h-[200px] whitespace-pre-wrap break-words m-0">
                {JSON.stringify(progress, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
});

SuperFilesPanel.displayName = 'SuperFilesPanel';

const PhaseBadge: React.FC<{ phase: string }> = React.memo(({ phase }) => {
  const colorMap: Record<string, string> = {
    planning: 'bg-[rgba(168,85,247,0.15)] text-purple-400',
    building: 'bg-[rgba(59,130,246,0.15)] text-[var(--nim-primary)]',
    running: 'bg-[rgba(59,130,246,0.15)] text-[var(--nim-primary)]',
    completed: 'bg-[rgba(74,222,128,0.15)] text-[#4ade80]',
    blocked: 'bg-[rgba(249,115,22,0.15)] text-orange-500',
    failed: 'bg-[rgba(239,68,68,0.15)] text-[var(--nim-error)]',
    paused: 'bg-[rgba(234,179,8,0.15)] text-[var(--nim-warning)]',
  };
  const classes = colorMap[phase] ?? 'bg-[rgba(156,163,175,0.15)] text-[var(--nim-text-faint)]';

  return (
    <span className={`text-[9px] px-1.5 py-[0.0625rem] rounded-[0.625rem] font-medium ${classes}`}>
      {phase}
    </span>
  );
});

PhaseBadge.displayName = 'PhaseBadge';
