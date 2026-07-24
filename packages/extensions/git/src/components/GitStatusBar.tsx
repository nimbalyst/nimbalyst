import { useEffect, useState } from 'react';
import { ErrorDetailPopup } from './ErrorDetailPopup';

interface GitStatusBarProps {
  message: string | null;
  error: string | null;
  /** Label to put in the error popup header (e.g. the failed command). */
  errorCommand?: string;
  onDismissError: () => void;
  /** Optional handler for the "Show Details" link (e.g. switch to Output tab). */
  onShowDetails?: () => void;
}

const COPY_FEEDBACK_MS = 1500;

/** First non-empty line, used as the preview. */
function firstLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line) return line;
  }
  return text;
}

export function GitStatusBar({
  message,
  error,
  errorCommand,
  onDismissError,
  onShowDetails,
}: GitStatusBarProps) {
  const [showFull, setShowFull] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(t);
  }, [copied]);

  if (!message && !error) return null;

  const isError = Boolean(error);
  const text = error ?? message ?? '';
  const preview = isError ? firstLine(text) : text;
  const hasMore = isError && (text !== preview);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // ignore
    }
  };

  return (
    <>
      <div className={`git-log-status-bar ${isError ? 'error' : 'success'}`}>
        <span className="git-log-status-text" title={isError ? text : undefined}>
          {preview}
        </span>
        {isError && (
          <div className="git-log-status-actions">
            {hasMore && (
              <button
                type="button"
                className="git-log-status-action-btn"
                onClick={() => setShowFull(true)}
              >
                View full error
              </button>
            )}
            <button
              type="button"
              className="git-log-status-action-btn"
              onClick={handleCopy}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            {onShowDetails && (
              <button
                type="button"
                className="git-log-status-details-btn"
                onClick={onShowDetails}
              >
                Show Details
              </button>
            )}
            <button
              type="button"
              className="git-changes-dismiss-btn"
              onClick={onDismissError}
              title="Dismiss"
            >
              &#10005;
            </button>
          </div>
        )}
      </div>
      {showFull && (
        <ErrorDetailPopup
          command={errorCommand ?? 'git operation'}
          error={text}
          onClose={() => setShowFull(false)}
        />
      )}
    </>
  );
}
