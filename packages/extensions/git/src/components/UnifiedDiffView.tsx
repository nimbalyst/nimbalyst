import { useMemo } from 'react';

interface UnifiedDiffViewProps {
  diff: string;
  isBinary?: boolean;
  loading?: boolean;
  error?: string | null;
}

type LineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

interface DiffLine {
  kind: LineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      const match = raw.match(HUNK_RE);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[3], 10);
        inHunk = true;
      }
      out.push({ kind: 'hunk', text: raw });
      continue;
    }

    if (!inHunk) {
      if (raw === '') continue;
      out.push({ kind: 'meta', text: raw });
      continue;
    }

    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push({ kind: 'add', text: raw.slice(1), newLine });
      newLine++;
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      out.push({ kind: 'del', text: raw.slice(1), oldLine });
      oldLine++;
    } else if (raw.startsWith(' ')) {
      out.push({ kind: 'ctx', text: raw.slice(1), oldLine, newLine });
      oldLine++;
      newLine++;
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file"
      out.push({ kind: 'meta', text: raw });
    }
  }

  return out;
}

export function UnifiedDiffView({ diff, isBinary, loading, error }: UnifiedDiffViewProps) {
  const lines = useMemo(() => (diff ? parseUnifiedDiff(diff) : []), [diff]);

  if (loading) {
    return <div className="git-diff-placeholder">Loading diff...</div>;
  }
  if (error) {
    return <div className="git-diff-placeholder git-diff-placeholder--error">{error}</div>;
  }
  if (isBinary) {
    return <div className="git-diff-placeholder">Binary file</div>;
  }
  if (!diff || lines.length === 0) {
    return <div className="git-diff-placeholder">No textual changes</div>;
  }

  return (
    <div className="git-diff-body">
      {lines.map((line, i) => {
        if (line.kind === 'meta') {
          return null;
        }
        if (line.kind === 'hunk') {
          return (
            <div key={i} className="git-diff-line git-diff-line--hunk">
              <span className="git-diff-gutter git-diff-gutter--hunk" />
              <span className="git-diff-text">{line.text}</span>
            </div>
          );
        }
        return (
          <div key={i} className={`git-diff-line git-diff-line--${line.kind}`}>
            <span className="git-diff-gutter">
              <span className="git-diff-gutter-num">{line.oldLine ?? ''}</span>
              <span className="git-diff-gutter-num">{line.newLine ?? ''}</span>
              <span className="git-diff-gutter-sign">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
              </span>
            </span>
            <span className="git-diff-text">{line.text || ' '}</span>
          </div>
        );
      })}
    </div>
  );
}

export function diffStats(diff: string): { added: number; removed: number } {
  if (!diff) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+') && !raw.startsWith('+++')) added++;
    else if (raw.startsWith('-') && !raw.startsWith('---')) removed++;
  }
  return { added, removed };
}
