/**
 * CommitsTab — chronological list of the PR's commits.
 */

import { useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import {
  getPullRequestService,
  type PullRequestRow,
  type PullRequestCommitRow,
} from '../../../services/RendererPullRequestService';
import { formatRelative } from '../prFormat';

interface CommitsTabProps {
  workspaceId: string;
  remote: string;
  pr: PullRequestRow;
  refreshToken: number;
}

export function CommitsTab({ workspaceId, remote, pr, refreshToken }: CommitsTabProps): JSX.Element {
  const [commits, setCommits] = useState<PullRequestCommitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedSha, setCopiedSha] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getPullRequestService()
      .commits(workspaceId, remote, pr.number)
      .then((rows) => {
        if (!cancelled) setCommits(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load commits');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, remote, pr.number, refreshToken]);

  const handleCopy = (sha: string) => {
    navigator.clipboard.writeText(sha).then(
      () => {
        setCopiedSha(sha);
        setTimeout(() => setCopiedSha((s) => (s === sha ? null : s)), 1500);
      },
      () => {
        /* clipboard denied — ignore */
      },
    );
  };

  return (
    <div className="pr-commits-tab flex flex-col flex-1 min-h-0 overflow-y-auto" data-testid="pr-commits-tab">
      {loading && commits.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-6 text-nim-muted text-sm">
          <div className="spinner w-4 h-4 border-[2px] border-nim-secondary border-t-nim-accent rounded-full animate-spin" />
          Loading commits…
        </div>
      ) : error ? (
        <div className="text-nim-error text-sm p-4">{error}</div>
      ) : commits.length === 0 ? (
        <div className="text-nim-faint text-sm text-center py-6">No commits.</div>
      ) : (
        commits.map((commit) => (
          <div
            key={commit.sha}
            className="flex items-center gap-3 px-4 py-2 border-b border-nim"
            data-testid="pr-commit-row"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm text-nim truncate">{commit.message.split('\n')[0]}</div>
              <div className="text-[11px] text-nim-faint flex items-center gap-2 mt-0.5">
                {commit.authorLogin && <span>{commit.authorLogin}</span>}
                <span>{formatRelative(commit.authoredAt)}</span>
                {(commit.additions > 0 || commit.deletions > 0) && (
                  <span className="font-mono">
                    {commit.additions > 0 && (
                      <span className="text-nim-success">+{commit.additions}</span>
                    )}
                    {commit.additions > 0 && commit.deletions > 0 && ' '}
                    {commit.deletions > 0 && (
                      <span className="text-nim-error">-{commit.deletions}</span>
                    )}
                  </span>
                )}
              </div>
            </div>
            <button
              className="flex items-center gap-1 px-1.5 py-1 rounded text-[11px] font-mono text-nim-muted hover:text-nim hover:bg-nim-tertiary transition-colors shrink-0"
              onClick={() => handleCopy(commit.sha)}
              title="Copy SHA"
            >
              <MaterialSymbol icon={copiedSha === commit.sha ? 'check' : 'content_copy'} size={12} />
              {commit.sha.slice(0, 7)}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
