/**
 * ConversationTab — read-only PR description, inline review threads, and the
 * comment/review timeline.
 *
 * Three sections, each Markdown-rendered:
 *   - Description: the PR body.
 *   - Review threads: inline (line-level) review comments grouped by thread,
 *     each tagged Open / Resolved (and Outdated when GitHub marks it so).
 *     Resolved threads start collapsed. Sourced from `pr:review-threads`
 *     (GraphQL — REST can't report resolution state).
 *   - Conversation: PR-level issue comments + review summaries.
 */

import { useEffect, useState } from 'react';
import { MaterialSymbol, MarkdownRenderer } from '@nimbalyst/runtime';
import {
  getPullRequestService,
  type PullRequestRow,
  type PullRequestTimelineEntry,
  type ReviewThread,
} from '../../../services/RendererPullRequestService';
import { formatRelative } from '../prFormat';

interface ConversationTabProps {
  workspaceId: string;
  remote: string;
  pr: PullRequestRow;
  /** Bumps to force a reload (detail-level poll). */
  refreshToken: number;
}

export function ConversationTab({
  workspaceId,
  remote,
  pr,
  refreshToken,
}: ConversationTabProps): JSX.Element {
  const [timeline, setTimeline] = useState<PullRequestTimelineEntry[]>([]);
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [threadsTruncated, setThreadsTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draftComment, setDraftComment] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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

  // Review threads load independently — a GraphQL failure shouldn't blank the
  // rest of the tab.
  useEffect(() => {
    let cancelled = false;
    getPullRequestService()
      .reviewThreads(workspaceId, remote, pr.number)
      .then((res) => {
        if (cancelled) return;
        setThreads(res.threads);
        setThreadsTruncated(res.truncated);
      })
      .catch(() => {
        if (!cancelled) {
          setThreads([]);
          setThreadsTruncated(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, remote, pr.number, refreshToken]);

  const unresolvedCount = threads.filter((t) => !t.isResolved).length;

  const handleSubmitComment = async (): Promise<void> => {
    const body = draftComment.trim();
    if (!body || submitting) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      await getPullRequestService().comment(workspaceId, remote, pr.number, body);
      const refreshed = await getPullRequestService().refreshConversation(
        workspaceId,
        remote,
        pr.number,
      );
      setTimeline(refreshed);
      setDraftComment('');
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to post comment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pr-conversation-tab block p-4 space-y-3 overflow-y-auto flex-1 min-h-0" data-testid="pr-conversation-tab">
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

      {/* ---- Review threads (inline, line-level) ---- */}
      {threads.length > 0 && (
        <>
          <SectionHeader
            label="Review threads"
            icon="rate_review"
            count={threads.length}
            note={unresolvedCount > 0 ? `${unresolvedCount} open` : 'all resolved'}
          />
          {threads.map((thread) => (
            <ReviewThreadCard key={thread.id} thread={thread} />
          ))}
          {threadsTruncated && (
            <div className="text-nim-faint text-[11px] italic">
              Showing the first page of review threads.
            </div>
          )}
        </>
      )}

      {/* ---- Conversation (comments + reviews) ---- */}
      <SectionHeader
        label="Conversation"
        icon="forum"
        count={timeline.length > 0 ? timeline.length : undefined}
      />

      <div className="border border-nim rounded-md bg-nim-secondary">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-nim text-xs text-nim-muted">
          <MaterialSymbol icon="add_comment" size={14} />
          Add comment
        </div>
        <div className="p-3 space-y-3">
          <textarea
            value={draftComment}
            onChange={(e) => setDraftComment(e.target.value)}
            placeholder="Leave a comment on this pull request"
            rows={4}
            data-testid="pr-comment-input"
            className="nim-input w-full resize-y text-sm min-h-[96px]"
          />
          {submitError && (
            <div className="text-nim-error text-sm flex items-center gap-2">
              <MaterialSymbol icon="error" size={16} />
              {submitError}
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleSubmitComment()}
              disabled={submitting || draftComment.trim().length === 0}
              className="flex items-center gap-1 px-3 py-1.5 rounded bg-nim-primary text-nim-on-primary hover:bg-nim-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              data-testid="pr-comment-submit"
            >
              {submitting ? (
                <div className="spinner w-4 h-4 border-[2px] border-white/25 border-t-white rounded-full animate-spin" />
              ) : (
                <MaterialSymbol icon="send" size={14} />
              )}
              Comment
            </button>
          </div>
        </div>
      </div>

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

/**
 * One inline review thread: a file:line header with an Open/Resolved badge,
 * collapsible (resolved threads start collapsed), with its comments rendered
 * as Markdown.
 */
function ReviewThreadCard({ thread }: { thread: ReviewThread }): JSX.Element {
  const [expanded, setExpanded] = useState(!thread.isResolved);
  const location = thread.path
    ? `${thread.path}${thread.line != null ? `:${thread.line}` : ''}`
    : 'general';

  return (
    <div className="border border-nim rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-nim-secondary border-b border-nim text-xs text-nim-muted text-left hover:text-nim transition-colors"
        data-testid="pr-review-thread-header"
      >
        <MaterialSymbol icon={expanded ? 'expand_more' : 'chevron_right'} size={14} />
        <span className="font-mono text-nim truncate flex-1" title={location}>
          {location}
        </span>
        {thread.isOutdated && <span className="text-nim-faint shrink-0">outdated</span>}
        <span
          className={`flex items-center gap-1 shrink-0 ${
            thread.isResolved ? 'text-nim-success' : 'text-nim-accent'
          }`}
        >
          <MaterialSymbol
            icon={thread.isResolved ? 'check_circle' : 'radio_button_unchecked'}
            size={13}
          />
          {thread.isResolved ? 'Resolved' : 'Open'}
        </span>
        <span className="shrink-0">{thread.comments.length}</span>
      </button>
      {expanded && (
        <div>
          {thread.comments.map((c) => (
            <div key={c.id} className="px-3 py-2 border-b border-nim last:border-b-0">
              <div className="flex items-center gap-2 text-[11px] text-nim-muted mb-1">
                {c.authorLogin && <span className="font-medium text-nim">{c.authorLogin}</span>}
                <span className="ml-auto">{formatRelative(c.createdAt)}</span>
              </div>
              {c.body.trim() && (
                <div className="text-sm text-nim select-text">
                  <MarkdownRenderer content={c.body} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionHeader({
  label,
  icon,
  count,
  note,
}: {
  label: string;
  icon: string;
  count?: number;
  note?: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-nim-faint mt-1 first:mt-0">
      <MaterialSymbol icon={icon} size={14} />
      <span>{label}</span>
      {count !== undefined && (
        <span className="text-nim-muted normal-case font-normal">({count})</span>
      )}
      {note && <span className="text-nim-muted normal-case font-normal">· {note}</span>}
    </div>
  );
}
