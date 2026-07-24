import { useEffect, useMemo, useRef, useState } from 'react';
import type { OperationLogEntry } from '../hooks/useOperationLog';
import { ErrorDetailPopup } from './ErrorDetailPopup';

interface OutputTabProps {
  entries: OperationLogEntry[];
  onClear: () => void;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const ERROR_PREVIEW_LINES = 3;
const COPY_FEEDBACK_MS = 1500;

function ErrorBlock({ command, error }: { command: string; error: string }) {
  const [showFull, setShowFull] = useState(false);
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => error.split('\n').filter(Boolean), [error]);
  const hasMore = lines.length > ERROR_PREVIEW_LINES;
  const visibleLines = hasMore ? lines.slice(0, ERROR_PREVIEW_LINES) : lines;
  const hiddenCount = lines.length - visibleLines.length;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(error);
      setCopied(true);
    } catch {
      // ignore
    }
  };

  return (
    <>
      <div className="git-output-lines git-output-lines--error">
        {visibleLines.map((line, i) => (
          <div key={i} className="git-output-line">&gt; {line}</div>
        ))}
        {hasMore && (
          <div className="git-output-line git-output-line--more">
            ...{hiddenCount} more {hiddenCount === 1 ? 'line' : 'lines'}
          </div>
        )}
      </div>
      <div className="git-output-error-actions">
        {hasMore && (
          <button
            type="button"
            className="git-output-action-btn"
            onClick={() => setShowFull(true)}
          >
            View full error
          </button>
        )}
        <button
          type="button"
          className="git-output-action-btn"
          onClick={handleCopy}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {showFull && (
        <ErrorDetailPopup
          command={command}
          error={error}
          onClose={() => setShowFull(false)}
        />
      )}
    </>
  );
}

function EntryRow({ entry }: { entry: OperationLogEntry }) {
  const borderClass =
    entry.status === 'error' ? 'git-output-entry--error' :
    entry.status === 'running' ? 'git-output-entry--running' :
    entry.status === 'interrupted' ? 'git-output-entry--interrupted' :
    'git-output-entry--success';

  return (
    <div className={`git-output-entry ${borderClass}`}>
      <div className="git-output-entry-header">
        <span className="git-output-timestamp">{formatTime(entry.timestamp)}</span>
        <code className="git-output-command">{entry.command}</code>
      </div>

      {entry.output && (
        <div className="git-output-lines">
          {entry.output.split('\n').filter(Boolean).map((line, i) => (
            <div key={i} className="git-output-line">&gt; {line}</div>
          ))}
        </div>
      )}

      {entry.error && !entry.output.includes(entry.error.trim()) && (
        <ErrorBlock command={entry.command} error={entry.error} />
      )}

      {entry.status === 'success' && (
        <div className="git-output-status git-output-status--success">
          &#10003; Completed{entry.durationMs != null ? ` in ${formatDuration(entry.durationMs)}` : ''}
        </div>
      )}

      {entry.status === 'error' && (
        <div className="git-output-status git-output-status--error">
          &#10007; Failed{entry.exitCode != null ? ` (exit ${entry.exitCode})` : ''}
          {entry.durationMs != null ? ` after ${formatDuration(entry.durationMs)}` : ''}
        </div>
      )}

      {entry.status === 'interrupted' && (
        <div className="git-output-status git-output-status--interrupted">
          Interrupted{entry.durationMs != null ? ` after ${formatDuration(entry.durationMs)}` : ''}
        </div>
      )}

      {entry.status === 'running' && (
        <div className="git-output-status git-output-status--running">
          <span className="git-output-spinner" /> Running...
        </div>
      )}

      {entry.suggestion && (
        <div className="git-output-suggestion">
          Suggestion: {entry.suggestion}
        </div>
      )}
    </div>
  );
}

export function OutputTab({ entries, onClear }: OutputTabProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll while commands append output as well as when entries are added.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="git-output-empty">
        <span>No operations recorded yet.</span>
        <span className="git-output-empty-hint">Push, pull, fetch, and commit operations will appear here.</span>
      </div>
    );
  }

  return (
    <div className="git-output-tab">
      <div className="git-output-scroll" ref={scrollRef}>
        {entries.map(entry => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </div>
      <div className="git-output-footer">
        <button className="git-output-clear-btn" onClick={onClear}>
          Clear Log
        </button>
      </div>
    </div>
  );
}
