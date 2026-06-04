import React, { useState } from 'react';
import { MaterialSymbol } from '../../icons/MaterialSymbol';

const COMMIT_REQUEST_PREFIX = 'Use the developer_git_commit_proposal tool to create a commit.';

interface ParsedCommitFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

interface ParsedCommitRequest {
  files: ParsedCommitFile[];
  scenario: 'single' | 'workstream';
  sessionCount?: number;
  isWorktree: boolean;
}

export function isCommitRequestMessage(text: string): boolean {
  // Detect on the file-list header rather than the exact "call the tool" wording.
  // The instruction sentence is reworded between producers (GitOperationsPanel,
  // voiceModeListeners), but the injected list always opens with this header --
  // and it's only present when there ARE files for the card to show.
  return text.startsWith(COMMIT_REQUEST_PREFIX) &&
    text.includes('Here are the files edited');
}

export function parseCommitRequest(text: string): ParsedCommitRequest | null {
  if (!isCommitRequestMessage(text)) return null;

  const files: ParsedCommitFile[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/^- (.+) \((added|modified|deleted)\)$/);
    if (match) {
      files.push({ path: match[1], status: match[2] as ParsedCommitFile['status'] });
    }
  }

  const isWorkstream = text.includes('across') && text.includes('sessions');
  const sessionCountMatch = text.match(/across (\d+) sessions/);
  const isWorktree = text.includes('worktree branch');

  return {
    files,
    scenario: isWorkstream ? 'workstream' : 'single',
    sessionCount: sessionCountMatch ? parseInt(sessionCountMatch[1], 10) : undefined,
    isWorktree,
  };
}

const STATUS_COLORS: Record<string, string> = {
  added: 'text-[var(--nim-success)]',
  modified: 'text-[var(--nim-info)]',
  deleted: 'text-[var(--nim-error)]',
};

interface CommitRequestCardProps {
  request: ParsedCommitRequest;
}

export const CommitRequestCard: React.FC<CommitRequestCardProps> = ({ request }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const { files, scenario, sessionCount, isWorktree } = request;

  const scopeLabel = scenario === 'workstream'
    ? `${files.length} file${files.length !== 1 ? 's' : ''} across ${sessionCount ?? '?'} sessions`
    : `${files.length} file${files.length !== 1 ? 's' : ''}`;

  return (
    <div className="rounded-lg bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] overflow-hidden">
      <button
        className="w-full flex items-center gap-2 p-2 bg-transparent border-none cursor-pointer text-left transition-colors hover:bg-[var(--nim-bg-hover)]"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <MaterialSymbol icon="commit" size={16} className="text-[var(--nim-primary)] shrink-0" />
        <span className="text-sm font-medium text-[var(--nim-text)] flex-1">
          Requesting commit proposal
        </span>
        <span className="text-xs text-[var(--nim-text-faint)]">
          {scopeLabel}
        </span>
        {isWorktree && (
          <span className="text-[10px] rounded-full font-medium px-1.5 py-0.5 bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)]">
            worktree
          </span>
        )}
        <MaterialSymbol
          icon={isExpanded ? 'expand_less' : 'expand_more'}
          size={16}
          className="text-[var(--nim-text-faint)] shrink-0"
        />
      </button>

      {isExpanded && files.length > 0 && (
        <div className="px-2 pb-2 flex flex-col gap-0.5 border-t border-[var(--nim-border)]">
          {files.map((file) => (
            <div
              key={file.path}
              className="flex items-center gap-1.5 px-2 py-0.5 text-[0.8125rem]"
            >
              <span className={`font-mono ${STATUS_COLORS[file.status] || 'text-[var(--nim-text)]'}`}>
                {file.path.split('/').pop()}
              </span>
              <span className="text-[var(--nim-text-faint)] text-xs truncate">
                {file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
