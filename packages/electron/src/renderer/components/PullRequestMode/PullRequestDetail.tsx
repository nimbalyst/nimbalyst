/**
 * PullRequestDetail — read-only PR detail panel (issue #307, Phase G).
 *
 * Header (number, title, author, state, "Open on GitHub", and — when wired in
 * Phase H — "Open branch in Claude Code") plus a four-tab body: Conversation,
 * Files Changed, Commits, Checks.
 *
 * While mounted it re-fetches the visible tab every 60s via a bumped
 * `refreshToken`, in addition to the list-level poll scheduler.
 */

import { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  prModeLayoutAtom,
  setPrModeLayoutAtom,
  type PrDetailTab,
} from '../../store/atoms/pullRequests';
import type { PullRequestRow } from '../../services/RendererPullRequestService';
import { ConversationTab } from './tabs/ConversationTab';
import { FilesChangedTab } from './tabs/FilesChangedTab';
import { CommitsTab } from './tabs/CommitsTab';
import { ChecksTab } from './tabs/ChecksTab';

interface PullRequestDetailProps {
  workspaceId: string;
  remote: string;
  pr: PullRequestRow;
  onClose: () => void;
  /** Provided in Phase H to wire the "Open branch in Claude Code" action. */
  onOpenInClaudeCode?: () => void;
}

const TABS: { id: PrDetailTab; label: string }[] = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'files', label: 'Files Changed' },
  { id: 'commits', label: 'Commits' },
  { id: 'checks', label: 'Checks' },
];

const DETAIL_POLL_MS = 60_000;

function htmlUrlOf(pr: PullRequestRow): string | null {
  const raw = pr.raw as { html_url?: unknown } | null;
  return raw && typeof raw.html_url === 'string' ? raw.html_url : null;
}

export function PullRequestDetail({
  workspaceId,
  remote,
  pr,
  onClose,
  onOpenInClaudeCode,
}: PullRequestDetailProps): JSX.Element {
  const layout = useAtomValue(prModeLayoutAtom);
  const setLayout = useSetAtom(setPrModeLayoutAtom);
  const activeTab = layout.activeDetailTab;

  const [refreshToken, setRefreshToken] = useState(0);

  // Detail-level poll: bump the token every 60s while this panel is mounted.
  useEffect(() => {
    const timer = setInterval(() => setRefreshToken((t) => t + 1), DETAIL_POLL_MS);
    return () => clearInterval(timer);
  }, [pr.id]);

  const htmlUrl = htmlUrlOf(pr);

  return (
    <div className="pr-detail flex flex-col h-full w-full overflow-hidden bg-nim" data-testid="pr-detail">
      {/* Header */}
      <div className="shrink-0 border-b border-nim">
        <div className="flex items-start gap-2 px-4 pt-3">
          <button
            className="flex items-center gap-1 px-2 h-7 text-xs text-nim-muted hover:text-nim border border-nim rounded shrink-0 -ml-1"
            onClick={onClose}
            title="Back to pull requests"
            data-testid="pr-detail-close"
          >
            <MaterialSymbol icon="arrow_back" size={16} />
            Back
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-nim-faint font-mono">#{pr.number}</span>
              <span className="text-nim font-medium truncate">{pr.title}</span>
            </div>
            <div className="flex items-center gap-2 mt-1 text-[11px] text-nim-faint">
              {pr.authorLogin && <span>{pr.authorLogin}</span>}
              <span className="font-mono truncate">
                {pr.baseRef} ← {pr.headRef}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {htmlUrl && (
              <button
                className="flex items-center gap-1 px-2 py-1 text-xs text-nim-muted hover:text-nim border border-nim rounded transition-colors"
                onClick={() => window.electronAPI?.openExternal(htmlUrl)}
                title="Open on GitHub"
              >
                <MaterialSymbol icon="open_in_new" size={14} />
                GitHub
              </button>
            )}
            {onOpenInClaudeCode && (
              <button
                className="flex items-center gap-1 px-2 py-1 text-xs bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover rounded transition-colors"
                onClick={onOpenInClaudeCode}
                data-testid="pr-open-in-claude-code"
              >
                <MaterialSymbol icon="code" size={14} />
                Open branch in Claude Code
              </button>
            )}
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-1 px-3 mt-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              data-testid={`pr-tab-${tab.id}`}
              onClick={() => setLayout({ activeDetailTab: tab.id })}
              className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-[var(--nim-primary)] text-nim'
                  : 'border-transparent text-nim-muted hover:text-nim'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'conversation' && (
          <ConversationTab workspaceId={workspaceId} remote={remote} pr={pr} refreshToken={refreshToken} />
        )}
        {activeTab === 'files' && (
          <FilesChangedTab workspaceId={workspaceId} remote={remote} pr={pr} refreshToken={refreshToken} />
        )}
        {activeTab === 'commits' && (
          <CommitsTab workspaceId={workspaceId} remote={remote} pr={pr} refreshToken={refreshToken} />
        )}
        {activeTab === 'checks' && (
          <ChecksTab workspaceId={workspaceId} remote={remote} pr={pr} refreshToken={refreshToken} />
        )}
      </div>
    </div>
  );
}
