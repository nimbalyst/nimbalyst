import React, { useState } from 'react';
import { MaterialSymbol } from '../../icons/MaterialSymbol';
import {
  COMMIT_FILE_LIST_END,
  COMMIT_FILE_LIST_HEADERS,
  COMMIT_FILE_COUNT_PREFIX,
  COMMIT_PROMPT_PREFIX,
  isCommitPromptSafePath,
} from '../utils/commitPromptBuilder';

const EXCLUDED_FILE_NOTICE_PATTERN = /^Excluded file paths with control characters: (\d+)\. Review and commit them separately\.$/;

/** The opening sentence every commit request has always started with. */
const LEGACY_COMMIT_PROMPT_PREFIX = 'Use the developer_git_commit_proposal tool to create a commit.';

interface ParsedCommitFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

interface ParsedCommitRequest {
  files: ParsedCommitFile[];
  scenario: 'single' | 'workstream';
  sessionCount?: number;
  isWorktree: boolean;
  excludedFileCount: number;
}

interface CommitFileListBounds {
  lines: string[];
  headerIndex: number;
  endIndex: number;
}

function findCommitFileListBounds(text: string): CommitFileListBounds | null {
  if (!text.startsWith(COMMIT_PROMPT_PREFIX)) return null;

  const lines = text.split('\n');
  const headerIndexes = lines.flatMap((line, index) =>
    COMMIT_FILE_LIST_HEADERS.some((header) => line.startsWith(header)) ? [index] : [],
  );
  const endIndexes = lines.flatMap((line, index) => line === COMMIT_FILE_LIST_END ? [index] : []);

  if (headerIndexes.length !== 1 || endIndexes.length !== 1 || endIndexes[0] <= headerIndexes[0]) {
    return null;
  }

  const countLine = lines[headerIndexes[0] + 1];
  const countMatch = countLine?.match(new RegExp(`^${COMMIT_FILE_COUNT_PREFIX}(\\d+)\\.$`));
  if (!countMatch || Number(countMatch[1]) !== endIndexes[0] - headerIndexes[0] - 2) {
    return null;
  }

  return { lines, headerIndex: headerIndexes[0], endIndex: endIndexes[0] };
}

/**
 * Bounds for messages produced before the count/end markers existed.
 *
 * Transcripts are persisted, so every commit request already sitting in a user's
 * session history lacks those markers. Without this fallback the strict parser
 * returns null for all of them and years of past commit cards re-render as walls
 * of raw prompt text. Rows are still bounded to the contiguous block after the
 * header -- stricter than the original scan-every-line parser -- and these
 * messages were sent long ago, so the card is display-only history at this point.
 */
function findLegacyCommitFileListBounds(text: string): CommitFileListBounds | null {
  // Match the opening sentence only. The current prefix appends a ToolSearch
  // instruction that older recorded prompts do not carry.
  if (!text.startsWith(LEGACY_COMMIT_PROMPT_PREFIX)) return null;
  if (text.includes(COMMIT_FILE_LIST_END)) return null;

  const lines = text.split('\n');
  const headerIndex = lines.findIndex((line) =>
    COMMIT_FILE_LIST_HEADERS.some((header) => line.startsWith(header)),
  );
  if (headerIndex === -1) return null;

  let endIndex = headerIndex + 1;
  while (endIndex < lines.length && /^- (.+) \((added|modified|deleted)\)$/.test(lines[endIndex])) {
    endIndex += 1;
  }
  if (endIndex === headerIndex + 1) return null;

  // The strict reader skips a count line; legacy messages have none, so shift
  // the header back one to keep `headerIndex + 2` landing on the first row.
  return { lines, headerIndex: headerIndex - 1, endIndex };
}

export function isCommitRequestMessage(text: string): boolean {
  return findCommitFileListBounds(text) !== null || findLegacyCommitFileListBounds(text) !== null;
}

export function parseCommitRequest(text: string): ParsedCommitRequest | null {
  const strictBounds = findCommitFileListBounds(text);
  const bounds = strictBounds ?? findLegacyCommitFileListBounds(text);
  if (!bounds) return null;

  const files: ParsedCommitFile[] = [];

  for (const line of bounds.lines.slice(bounds.headerIndex + 2, bounds.endIndex)) {
    const match = line.match(/^- (.+) \((added|modified|deleted)\)$/);
    if (!match) return null;
    // Only the marker-bearing format carries the producer's safety guarantee;
    // legacy history predates it and must still render.
    if (strictBounds && !isCommitPromptSafePath(match[1])) return null;
    files.push({ path: match[1], status: match[2] as ParsedCommitFile['status'] });
  }

  const excludedFileNotice = bounds.lines[bounds.endIndex + 2]?.match(EXCLUDED_FILE_NOTICE_PATTERN);

  const isWorkstream = text.includes('across') && text.includes('sessions');
  const sessionCountMatch = text.match(/across (\d+) sessions/);
  const isWorktree = text.includes('worktree branch');

  return {
    files,
    scenario: isWorkstream ? 'workstream' : 'single',
    sessionCount: sessionCountMatch ? parseInt(sessionCountMatch[1], 10) : undefined,
    isWorktree,
    excludedFileCount: excludedFileNotice ? parseInt(excludedFileNotice[1], 10) : 0,
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
  const { files, scenario, sessionCount, isWorktree, excludedFileCount } = request;

  const scopeLabel = scenario === 'workstream'
    ? `${files.length} file${files.length !== 1 ? 's' : ''} across ${sessionCount ?? '?'} sessions`
    : `${files.length} file${files.length !== 1 ? 's' : ''}`;
  const requestLabel = files.length === 0 && excludedFileCount > 0
    ? 'Commit proposal blocked'
    : 'Requesting commit proposal';

  return (
    <div className="rounded-lg bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] overflow-hidden">
      <button
        className="w-full flex items-center gap-2 p-2 bg-transparent border-none cursor-pointer text-left transition-colors hover:bg-[var(--nim-bg-hover)]"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <MaterialSymbol icon="commit" size={16} className="text-[var(--nim-primary)] shrink-0" />
        <span className="text-sm font-medium text-[var(--nim-text)] flex-1">
          {requestLabel}
        </span>
        <span className="text-xs text-[var(--nim-text-faint)]">
          {scopeLabel}
        </span>
        {excludedFileCount > 0 && (
          <span
            className="text-[10px] rounded-full font-medium px-1.5 py-0.5 bg-[var(--nim-bg-tertiary)] text-[var(--nim-warning)]"
            title="File paths containing control characters cannot be safely included in an AI commit request."
          >
            {excludedFileCount} unsupported path{excludedFileCount === 1 ? '' : 's'} excluded
          </span>
        )}
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
