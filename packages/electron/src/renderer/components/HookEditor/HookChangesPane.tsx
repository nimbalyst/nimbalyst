/** The change to the file as text. Long runs of unchanged lines fold to a count. */

import type { DiffPart } from '../../../shared/hookEditor/hookWriter';

// How many unchanged lines stay visible at each end of a folded run.
const KEEP = 2;

export function HookChangesPane({ parts }: { parts: readonly DiffPart[] }) {
  return (
    <pre className="hook-changes-pane select-text overflow-auto p-2 font-mono text-xs" data-testid="hook-changes-text">
      {parts.map((part, index) => {
        const lines = part.text.replace(/\n$/, '').split('\n');
        if (part.kind === 'same' && lines.length > KEEP * 2 + 1) {
          return (
            <div key={index}>
              {lines.slice(0, KEEP).map((line, at) => <div key={`a${at}`}>{`  ${line}`}</div>)}
              <div className="text-[var(--nim-text-faint)]">{`  ... ${lines.length - KEEP * 2} lines not changed`}</div>
              {lines.slice(-KEEP).map((line, at) => <div key={`b${at}`}>{`  ${line}`}</div>)}
            </div>
          );
        }
        const mark = part.kind === 'added' ? '+ ' : part.kind === 'removed' ? '- ' : '  ';
        const colour = part.kind === 'added' ? 'text-[var(--nim-success)]' : part.kind === 'removed' ? 'text-[var(--nim-error)]' : '';
        return (
          <div key={index} className={colour}>
            {lines.map((line, at) => <div key={at}>{mark + line}</div>)}
          </div>
        );
      })}
    </pre>
  );
}
