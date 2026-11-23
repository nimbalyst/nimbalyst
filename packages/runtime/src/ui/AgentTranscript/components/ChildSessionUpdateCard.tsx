import React, { useState } from 'react';
import type { ChildSessionReport, ChildUpdateDisplay } from '../utils/parseChildSessionUpdate';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MaterialSymbol } from '../../icons/MaterialSymbol';

interface Callbacks {
  messageId?: string | number;
  onOpenFile?: (path: string) => void;
  onOpenSession?: (id: string) => void;
}

const STATUS_LABELS: Record<string, string> = {
  waiting_for_input: 'Waiting for input', idle: 'Idle', completed: 'Completed',
  error: 'Error', interrupted: 'Interrupted', running: 'Running',
};

function ReportCard({ report, onOpenFile, onOpenSession, messageId }: Callbacks & { report: ChildSessionReport }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="child-session-update-card select-text min-w-0 space-y-2 [&_.markdown-content]:font-normal">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {onOpenSession ? (
          <button type="button" className="text-[var(--nim-primary)] text-left break-words hover:underline"
            onClick={() => onOpenSession(report.sessionId)}>{report.title || report.sessionId}</button>
        ) : <span>{report.title || report.sessionId}</span>}
        <span className="text-xs text-[var(--nim-text-muted)]">{STATUS_LABELS[report.status] ?? report.status}</span>
        <span className="text-xs text-[var(--nim-text-faint)]" title={report.event}>{report.event.replace('session:', '')}</span>
      </div>
      {report.before && <MarkdownRenderer content={report.before} messageId={messageId == null ? undefined : messageId + ':before'} isUser onOpenFile={onOpenFile} onOpenSession={onOpenSession} />}
      {report.files.length > 0 && (
        <div className="child-session-update-files">
          <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
            className="flex items-center gap-1 text-sm text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]">
            <MaterialSymbol icon={expanded ? 'expand_more' : 'chevron_right'} size={16} />
            Files modified · {report.files.length}
          </button>
          {expanded && <ul className="m-0 mt-2 pl-5 text-sm space-y-1">
            {report.files.map((path, index) => <li key={index} className="break-all">
              {onOpenFile ? <a href="#" data-transcript-file-path={path}
                className="text-[var(--nim-primary)] hover:underline"
                onClick={event => { event.preventDefault(); onOpenFile(path); }}>{path}</a> : path}
            </li>)}
          </ul>}
        </div>
      )}
      {report.after && <MarkdownRenderer content={report.after} messageId={messageId == null ? undefined : messageId + ':after'} isUser onOpenFile={onOpenFile} onOpenSession={onOpenSession} />}
    </section>
  );
}

export function ChildSessionUpdateCard({ display, messageId, ...callbacks }: Callbacks & { display: ChildUpdateDisplay }) {
  return <div className="child-session-updates space-y-4">
    {display.segments.map((segment, index) => segment.report
      ? <ReportCard key={index} report={segment.report} messageId={messageId == null ? undefined : messageId + ':' + index} {...callbacks} />
      : <MarkdownRenderer key={index} content={segment.text} messageId={messageId == null ? undefined : messageId + ':' + index} isUser {...callbacks} />)}
  </div>;
}
