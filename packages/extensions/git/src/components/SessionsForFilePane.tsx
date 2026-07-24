import { useMemo } from 'react';
import { useSessionsForFile, type SessionEditEntry } from '../hooks/useSessionsForFile';

interface ActiveFile {
  path: string;
  group: string;
}

interface SessionsForFilePaneProps {
  workspacePath: string;
  activeFile: ActiveFile | null;
  onCollapse: () => void;
}

function formatRelative(ts: number): string {
  if (!ts) return '';
  const diffMs = Date.now() - ts;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

function providerChipClass(provider: string): string {
  if (provider.includes('codex')) return 'git-changes-sessions-provider-chip git-changes-sessions-provider-chip--codex';
  if (provider.includes('openai')) return 'git-changes-sessions-provider-chip git-changes-sessions-provider-chip--openai';
  return 'git-changes-sessions-provider-chip';
}

function openSession(sessionId: string, workspacePath: string) {
  // App.tsx listens for this event and routes the session into Agent mode.
  window.dispatchEvent(
    new CustomEvent('open-ai-session', {
      detail: { sessionId, workspacePath },
    }),
  );
}

function SessionRow({ entry, workspacePath }: { entry: SessionEditEntry; workspacePath: string }) {
  return (
    <div
      className="git-changes-sessions-row"
      onClick={() => openSession(entry.sessionId, workspacePath)}
      title={`Open session "${entry.title}"`}
    >
      <div className="git-changes-sessions-row-title">
        <span className={providerChipClass(entry.provider)} />
        <span className="git-changes-sessions-row-name">{entry.title}</span>
      </div>
      <div className="git-changes-sessions-row-meta">
        <span>{formatRelative(entry.lastEditAt)}</span>
        <span className="git-changes-sessions-row-stats">
          {entry.linesAdded > 0 && <span className="git-diff-stat-added">+{entry.linesAdded}</span>}
          {entry.linesRemoved > 0 && <span className="git-diff-stat-removed">−{entry.linesRemoved}</span>}
          {entry.editCount > 0 && <span>· {entry.editCount} edit{entry.editCount === 1 ? '' : 's'}</span>}
        </span>
      </div>
    </div>
  );
}

export function SessionsForFilePane({ workspacePath, activeFile, onCollapse }: SessionsForFilePaneProps) {
  // The attribution service stores absolute paths; ChangesTab works with workspace-relative.
  const absoluteFilePath = useMemo(() => {
    if (!activeFile) return null;
    return `${workspacePath}/${activeFile.path}`;
  }, [workspacePath, activeFile?.path]);

  const { data, loading, error } = useSessionsForFile(workspacePath, absoluteFilePath);

  const filename = activeFile?.path.split('/').pop() ?? null;

  return (
    <div className="git-changes-sessions-pane">
      <div className="git-changes-sessions-header">
        <div>
          <span className="git-changes-sessions-eyebrow">Sessions that edited this file</span>
          {filename && <span className="git-changes-sessions-subtitle" title={activeFile?.path}>{filename}</span>}
        </div>
        <button
          type="button"
          className="git-changes-sessions-collapse"
          onClick={onCollapse}
          title="Hide sessions pane"
        >
          ▶
        </button>
      </div>

      {!activeFile && (
        <div className="git-changes-sessions-empty">
          Select a file to see sessions that edited it.
        </div>
      )}

      {activeFile && loading && (
        <div className="git-changes-sessions-empty">Loading sessions...</div>
      )}

      {activeFile && error && !loading && (
        <div className="git-changes-sessions-empty">Failed to load: {error}</div>
      )}

      {activeFile && !loading && !error && data.length === 0 && (
        <div className="git-changes-sessions-empty">No sessions edited this file yet.</div>
      )}

      {activeFile && !loading && !error && data.length > 0 && (
        <>
          <div className="git-changes-sessions-list">
            {data.map(entry => (
              <SessionRow key={entry.sessionId} entry={entry} workspacePath={workspacePath} />
            ))}
          </div>
          <div className="git-changes-sessions-footer">
            {data.length} session{data.length === 1 ? '' : 's'} · most recent first
          </div>
        </>
      )}
    </div>
  );
}
