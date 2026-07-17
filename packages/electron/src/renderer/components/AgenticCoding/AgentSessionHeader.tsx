import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { ProviderIcon, MaterialSymbol } from '@nimbalyst/runtime';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import {
  sessionEditorStateAtom,
  setSessionLayoutModeAtom,
  sessionHasTabsAtom,
  worktreeGitStatusAtom,
} from '../../store';
import { worktreeDisplayNameUpdateAtom } from '../../store/atoms/worktrees';
import { LayoutControls } from '../UnifiedAI/LayoutControls';
import { dialogRef, DIALOG_IDS } from '../../dialogs';
import type { ShareDialogData } from '../../dialogs';
import { SessionOperationalIndicator } from './SessionOperationalIndicator';

interface WorktreeMetadata {
  id: string;
  name: string;
  displayName?: string;
  path: string;
  branch: string;
  base_branch?: string;
  isArchived?: boolean;
}

// Module-level cache for worktree metadata (not git status - that's in an atom)
const worktreeMetadataCache = new Map<string, WorktreeMetadata>();

interface AgentSessionHeaderProps {
  sessionData: SessionData | null;
  workspacePath: string;
  /** @deprecated - Now uses Jotai atom subscription. This prop is ignored. */
  isProcessing?: boolean;
}

export const AgentSessionHeader: React.FC<AgentSessionHeaderProps> = ({
  sessionData,
  workspacePath,
}) => {
  const sessionId = sessionData?.id ?? '';
  const worktreeId = sessionData?.worktreeId ?? '';

  // Layout state for non-worktree sessions
  const sessionEditorState = useAtomValue(sessionEditorStateAtom(sessionId));
  const setSessionLayoutMode = useSetAtom(setSessionLayoutModeAtom);
  const hasTabs = useAtomValue(sessionHasTabsAtom(sessionId));

  // Subscribe to worktree git status atom - updated by centralized listener on git:status-changed
  const worktreeGitStatus = useAtomValue(worktreeGitStatusAtom(worktreeId));

  // Determine if this is a worktree session (layout controls only for non-worktree)
  const isWorktreeSession = !!sessionData?.worktreeId;
  // Determine if this is a workstream child session (has a parent)
  const isWorkstreamSession = !!sessionData?.parentSessionId;
  const showLayoutControls = sessionData && !isWorktreeSession;
  // Use cached metadata immediately if available
  const cachedData = worktreeId ? worktreeMetadataCache.get(worktreeId) ?? null : null;
  const [worktreeMetadata, setWorktreeMetadata] = useState<WorktreeMetadata | null>(cachedData);
  const fetchingRef = useRef<string | null>(null);

  // Fetch worktree metadata if this is a worktree session
  // Note: Git status comes from the atom, not from this fetch
  const fetchWorktreeMetadata = useCallback(async (wtId: string) => {
    // Check cache first
    if (worktreeMetadataCache.has(wtId)) {
      return worktreeMetadataCache.get(wtId)!;
    }

    try {
      const result = await window.electronAPI.invoke('worktree:get', wtId);
      if (!result.success || !result.worktree) {
        return null;
      }

      const worktree = result.worktree;

      const metadata: WorktreeMetadata = {
        id: worktree.id,
        name: worktree.name,
        displayName: worktree.displayName,
        path: worktree.path,
        branch: worktree.branch,
        base_branch: worktree.base_branch,
        isArchived: worktree.isArchived,
      };

      // Cache the result
      worktreeMetadataCache.set(wtId, metadata);
      return metadata;
    } catch (err) {
      console.error('[AgentSessionHeader] Failed to fetch worktree metadata:', err);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!worktreeId) {
      setWorktreeMetadata(null);
      return;
    }

    // If we have cached data, use it immediately
    if (worktreeMetadataCache.has(worktreeId)) {
      setWorktreeMetadata(worktreeMetadataCache.get(worktreeId)!);
      return;
    }

    // Prevent duplicate fetches
    if (fetchingRef.current === worktreeId) {
      return;
    }

    fetchingRef.current = worktreeId;
    fetchWorktreeMetadata(worktreeId).then(data => {
      if (fetchingRef.current === worktreeId) {
        setWorktreeMetadata(data);
        fetchingRef.current = null;
      }
    });
  }, [worktreeId, fetchWorktreeMetadata]);

  // React to worktree display-name updates broadcast by main. The IPC event
  // is handled centrally in store/listeners/worktreeListeners.ts which writes
  // to worktreeDisplayNameUpdateAtom; we apply the update only when its
  // worktreeId matches ours and skip the initial-mount value so we don't
  // re-apply the most recent update from before this component mounted.
  const displayNameUpdate = useAtomValue(worktreeDisplayNameUpdateAtom);
  const initialDisplayNameUpdateRef = useRef(displayNameUpdate);
  useEffect(() => {
    if (!worktreeId) return;
    if (displayNameUpdate === initialDisplayNameUpdateRef.current) return;
    if (!displayNameUpdate || displayNameUpdate.payload.worktreeId !== worktreeId) return;

    const { displayName } = displayNameUpdate.payload;
    setWorktreeMetadata(prev => prev ? { ...prev, displayName } : null);
    if (worktreeMetadataCache.has(worktreeId)) {
      const cached = worktreeMetadataCache.get(worktreeId)!;
      worktreeMetadataCache.set(worktreeId, { ...cached, displayName });
    }
  }, [displayNameUpdate, worktreeId]);

  const handleShareLink = useCallback(() => {
    if (!sessionData) return;
    dialogRef.current?.open<ShareDialogData>(DIALOG_IDS.SHARE, {
      contentType: 'session',
      sessionId: sessionData.id,
      title: sessionData.title || 'Untitled Session',
    });
  }, [sessionData]);

  if (!sessionData) {
    return null;
  }

  const displayTitle = sessionData.title || 'Untitled Session';

  return (
    <div className="agent-session-header shrink-0 px-4 py-2 border-b border-[var(--nim-border)] bg-[var(--nim-bg)]">
      <div className="agent-session-header-main flex items-center gap-3">
        {/* Icon renders immediately - worktree icon if worktreeId exists, workstream icon if parentSessionId exists, otherwise provider icon */}
        {isWorktreeSession ? (
          <div className="agent-session-header-icon-wrapper relative shrink-0 w-6 h-6">
            <div className="agent-session-header-wt-icon w-6 h-6 text-[var(--nim-text-muted)] [&_svg]:w-full [&_svg]:h-full">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 21v-4a2 2 0 0 1 2-2h4"/>
                <path d="M14 15V7"/>
                <circle cx="8" cy="7" r="2"/>
                <circle cx="14" cy="7" r="2"/>
                <path d="M8 9v4a2 2 0 0 0 2 2"/>
              </svg>
            </div>
            <div className="agent-session-header-ai-badge absolute -bottom-0.5 -right-1 bg-[var(--nim-bg)] rounded-full p-0.5 flex items-center justify-center">
              <ProviderIcon provider={sessionData.provider || 'claude'} size={12} />
            </div>
          </div>
        ) : isWorkstreamSession ? (
          <div className="agent-session-header-icon workstream-header-icon shrink-0 text-[var(--nim-text-muted)]">
            <MaterialSymbol icon="account_tree" size={20} />
          </div>
        ) : (
          <div className="agent-session-header-icon shrink-0 text-[var(--nim-text-muted)]">
            <ProviderIcon provider={sessionData.provider || 'claude'} size={20} />
          </div>
        )}

        <div className="agent-session-header-content flex-1 min-w-0">
          <h1 className="agent-session-header-title m-0 text-base font-semibold text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis leading-tight">{displayTitle}</h1>

          <div className="agent-session-header-meta flex items-center gap-2 mt-0.5 text-xs text-[var(--nim-text-muted)]">
            {/* Meta info: worktree details load async, but we show model immediately for non-worktree */}
            {isWorktreeSession ? (
              worktreeMetadata ? (
                <>
                  <span className="agent-session-header-worktree-name text-[var(--nim-text-muted)] font-medium">{worktreeMetadata.name}</span>
                  {worktreeGitStatus && worktreeGitStatus.ahead > 0 && (
                    <span className="agent-session-header-badge ahead inline-flex items-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium uppercase tracking-wide bg-green-500/15 text-green-500">
                      {worktreeGitStatus.ahead} ahead
                    </span>
                  )}
                  {worktreeGitStatus && worktreeGitStatus.behind > 0 && (
                    <span className="agent-session-header-badge behind inline-flex items-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium uppercase tracking-wide bg-orange-500/15 text-orange-500">
                      {worktreeGitStatus.behind} behind
                    </span>
                  )}
                  {worktreeGitStatus?.hasUncommittedChanges && (
                    <span className="agent-session-header-badge uncommitted inline-flex items-center px-1.5 py-0.5 rounded text-[0.625rem] font-medium uppercase tracking-wide bg-violet-500/15 text-violet-500">
                      uncommitted
                    </span>
                  )}
                </>
              ) : (
                <span className="agent-session-header-worktree-name agent-session-header-loading text-[var(--nim-text-faint)] italic">Loading...</span>
              )
            ) : null}
          </div>
        </div>

        <SessionOperationalIndicator sessionId={sessionId} variant="standalone" />

        {/* Share button */}
        <button
          className="agent-session-header-share shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-transparent border-none text-[var(--nim-text-faint)] cursor-pointer transition-colors duration-150 hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          title="Share session link"
          onClick={handleShareLink}
        >
          <MaterialSymbol icon="link" size={16} />
        </button>

        {/* Export button */}
        <button
          className="agent-session-header-export shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-transparent border-none text-[var(--nim-text-faint)] cursor-pointer transition-colors duration-150 hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
          title="Export session as HTML"
          onClick={() => (window as any).electronAPI?.exportSessionToHtml({ sessionId: sessionData.id })}
        >
          <MaterialSymbol icon="download" size={16} />
        </button>

        {/* Layout controls for non-worktree sessions */}
        {showLayoutControls && (
          <div className="agent-session-header-layout-controls shrink-0 ml-auto pl-3 border-l border-[var(--nim-border)]">
            <LayoutControls
              mode={sessionEditorState.layoutMode}
              hasTabs={hasTabs}
              onModeChange={(mode) => setSessionLayoutMode({ sessionId: sessionData.id, mode })}
            />
          </div>
        )}
      </div>

    </div>
  );
};
