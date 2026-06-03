/**
 * ConversationTab — read-only PR description + comment/review timeline
 * (issue #307, Phase G).
 *
 * Renders the PR body followed by a chronological feed of issue comments and
 * reviews from `pr:conversation`. Bodies are shown as wrapped plain text
 * (no Markdown rendering in the MVP — deferred to a follow-up).
 */

import { useEffect, useState } from 'react';
import { MaterialSymbol, MarkdownRenderer } from '@nimbalyst/runtime';
import {
  getPullRequestService,
  type PullRequestRow,
  type PullRequestTimelineEntry,
} from '../../../services/RendererPullRequestService';

interface ConversationTabProps {
  workspaceId: string;
  remote: string;
  pr: PullRequestRow;
  /** Bumps to force a reload (detail-level poll). */
  refreshToken: number;
}

function formatRelative(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return `${Math.floor(day / 30)}mo ago`;
}

export function ConversationTab({
  workspaceId,
  remote,
  pr,
  refreshToken,
}: ConversationTabProps): JSX.Element {
  const [timeline, setTimeline] = useState<PullRequestTimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPullRequestService()
      .conversation(workspaceId, remote, pr.number)
      .then((entries) => {
        if (!cancelled) setTimeline(entries);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load conversation');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, remote, pr.number, refreshToken]);

  return (
    <div className="pr-conversation-tab flex flex-col gap-3 p-4 overflow-y-auto h-full" data-testid="pr-conversation-tab">
      {/* ---- Description (the PR body) ---- */}
      <SectionHeader label="Description" icon="description" />
      <div className="border border-nim rounded-md overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 bg-nim-secondary border-b border-nim text-xs text-nim-muted">
          {pr.authorLogin && <span className="font-medium text-nim">{pr.authorLogin}</span>}
          <span>opened this pull request</span>
          <span className="ml-auto">{formatRelative(pr.createdAt)}</span>
        </div>
        <div className="px-3 py-2 text-sm text-nim select-text">
          {pr.body?.trim() ? (
            <MarkdownRenderer content={pr.body} />
          ) : (
            <span className="text-nim-faint italic">No description provided.</span>
          )}
        </div>
      </div>

      {/* ---- Conversation (comments + reviews) ---- */}
      <SectionHeader
        label="Conversation"
        icon="forum"
        count={timeline.length > 0 ? timeline.length : undefined}
      />

      {error && (
        <div className="text-nim-error text-sm flex items-center gap-2">
          <MaterialSymbol icon="error" size={16} />
          {error}
        </div>
      )}

      {loading && timeline.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-6 text-nim-muted text-sm">
          <div className="spinner w-4 h-4 border-[2px] border-nim-secondary border-t-nim-accent rounded-full animate-spin" />
          Loading conversation…
        </div>
      ) : (
        timeline.map((entry) => (
          <div key={entry.id} className="border border-nim rounded-md overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-nim-secondary border-b border-nim text-xs text-nim-muted">
              {entry.authorLogin && <span className="font-medium text-nim">{entry.authorLogin}</span>}
              <span>
                {entry.type === 'review'
                  ? `reviewed${entry.state ? ` (${entry.state.toLowerCase()})` : ''}`
                  : 'commented'}
              </span>
              <span className="ml-auto">{formatRelative(entry.createdAt)}</span>
            </div>
            {entry.body.trim() && (
              <div className="px-3 py-2 text-sm text-nim select-text">
                <MarkdownRenderer content={entry.body} />
              </div>
            )}
          </div>
        ))
      )}

      {!loading && timeline.length === 0 && !error && (
        <div className="text-nim-faint text-sm text-center py-4">No comments yet.</div>
      )}
    </div>
  );
}

function SectionHeader({
  label,
  icon,
  count,
}: {
  label: string;
  icon: string;
  count?: number;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-nim-faint mt-1 first:mt-0">
      <MaterialSymbol icon={icon} size={14} />
      <span>{label}</span>
      {count !== undefined && (
        <span className="text-nim-muted normal-case font-normal">({count})</span>
      )}
    </div>
  );
}
