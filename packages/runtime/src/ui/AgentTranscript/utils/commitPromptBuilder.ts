/**
 * Producer half of the commit-request contract. The consumer half —
 * `isCommitRequestMessage` / `parseCommitRequest` in `../components/CommitRequestCard`
 * — lives in the same package on purpose: the coupling is stringly-typed, so the
 * two halves have to move together or the card silently stops recognizing the
 * prompt and the user gets a wall of raw text instead.
 */

export type CommitFileStatus = 'added' | 'modified' | 'deleted';

export interface CommitPromptFile {
  path: string;
  status: CommitFileStatus;
}

export interface CommitContext {
  success: boolean;
  files: CommitPromptFile[];
  scenario: 'single' | 'workstream' | 'worktree';
}

export interface SelectedCommitFile {
  path: string;
  status: string;
}

export const COMMIT_PROMPT_PREFIX =
  'Use the developer_git_commit_proposal tool to create a commit. If its schema is not loaded, use ToolSearch to load it first.';

export const COMMIT_FILE_LIST_HEADERS = [
  'Here are the files edited',
  'Here are all the uncommitted changes in this worktree:',
  'Here are the files selected for this commit:',
] as const;

export const COMMIT_FILE_LIST_END = 'End of commit file list.';
export const COMMIT_FILE_COUNT_PREFIX = 'Commit file count: ';

const CONTROL_CHARACTER_PATTERN = /[\x00-\x1f\x7f]/;

export function isCommitPromptSafePath(path: string): boolean {
  return !CONTROL_CHARACTER_PATTERN.test(path);
}

interface FormattedFileList {
  fileList: string;
  excludedFileCount: number;
}

function formatFileList(files: CommitPromptFile[]): FormattedFileList {
  // These prompts are auto-sent to tool-capable agents. Never let a pathname
  // introduce another prompt line; keep the count so the UI can disclose every
  // omission without echoing the unsafe data.
  const safeFiles = files.filter((file) => isCommitPromptSafePath(file.path));

  return {
    fileList: safeFiles.map((file) => `- ${file.path} (${file.status})`).join('\n'),
    excludedFileCount: files.length - safeFiles.length,
  };
}

function formatFileSection(header: string, files: CommitPromptFile[]): FormattedFileList & { section: string } {
  const formatted = formatFileList(files);
  const fileRows = formatted.fileList ? `${formatted.fileList}\n` : '';

  return {
    ...formatted,
    section: `${header}\n${COMMIT_FILE_COUNT_PREFIX}${files.length - formatted.excludedFileCount}.\n${fileRows}${COMMIT_FILE_LIST_END}`,
  };
}

function formatExcludedFileNotice(excludedFileCount: number): string {
  return excludedFileCount > 0
    ? `\n\nExcluded file paths with control characters: ${excludedFileCount}. Review and commit them separately.`
    : '';
}

export function buildCommitPrompt({
  commitContext,
  isInWorktree,
  workstreamSessionCount,
}: {
  commitContext: CommitContext;
  isInWorktree: boolean;
  workstreamSessionCount?: number;
}): string {
  let message = COMMIT_PROMPT_PREFIX;

  if (commitContext.success && commitContext.files.length > 0) {
    let formatted: ReturnType<typeof formatFileSection>;

    if (commitContext.scenario === 'worktree') {
      formatted = formatFileSection(
        'Here are all the uncommitted changes in this worktree:',
        commitContext.files,
      );
      message += `\n\n${formatted.section}`;
      message += formatExcludedFileNotice(formatted.excludedFileCount);
      message += formatted.excludedFileCount > 0
        ? '\n\nThe displayed list contains only the safely representable paths from this worktree. ' +
          'Do not infer or add the excluded paths to this proposal.'
        : '\n\nThis is the complete set of uncommitted changes in this worktree. ' +
          'A worktree is dedicated to a single line of work, so include all of these files in the commit.';
      message += formatted.fileList
        ? '\n\nThen call developer_git_commit_proposal with the file list.'
        : '\n\nNo safely representable file paths remain. Do not create a commit proposal.';
      message += '\nDo NOT call get_session_edited_files or get_workstream_edited_files -- the file data is already provided above.';
    } else {
      const scope = commitContext.scenario === 'workstream'
        ? `across ${workstreamSessionCount!} sessions in this workstream`
        : 'in this session';

      formatted = formatFileSection(
        `Here are the files edited ${scope} that have uncommitted changes:`,
        commitContext.files,
      );
      message += `\n\n${formatted.section}`;
      message += formatExcludedFileNotice(formatted.excludedFileCount);
      message += '\n\nThis list covers safely representable files edited directly. If you ALSO ran commands this session that change files as a side effect ' +
        '(e.g. npm install rewriting package-lock.json, a build/codegen step, license regeneration), include those changed files too -- ' +
        'check git status for them. If you ran no such commands, the list above is complete except for any explicitly reported excluded paths; do not go looking. ' +
        'Either way, do NOT add unrelated uncommitted changes -- other concurrent sessions may have their own work in this repo.';
      message += formatted.fileList
        ? '\n\nThen call developer_git_commit_proposal with the file list.'
        : '\n\nNo safely representable file paths remain. Do not create a commit proposal.';
      message += '\nDo NOT call get_session_edited_files or get_workstream_edited_files -- the edited-file data is already provided above.';
    }
  } else if (commitContext.success && commitContext.files.length === 0) {
    message += isInWorktree
      ? '\n\nNo uncommitted changes in this worktree.'
      : '\n\nNo session-edited files have uncommitted changes. Check git status to see if there are any other uncommitted changes to commit.';
  } else if (workstreamSessionCount !== undefined) {
    message += `\n\nThis session is part of a workstream with ${workstreamSessionCount} sessions. ` +
      'Use get_workstream_edited_files to find ALL files edited across the workstream. ' +
      'Cross-reference with git status to include all workstream-edited files that have uncommitted changes.';
  } else {
    message += '\n\nFirst call get_session_edited_files to find all files edited, ' +
      'then cross-reference with git status to include all session-edited files that have uncommitted changes.';
  }

  if (isInWorktree) {
    message += '\n\nThis work is on a worktree branch. ' +
      'Consider the full set of changes on this branch (vs the base branch) when writing the commit message, ' +
      'as the user may want a single commit summarizing all the work done on this branch.';
  }

  return message;
}

export function mapSelectedCommitFiles(files: SelectedCommitFile[]): CommitPromptFile[] {
  return files.flatMap((file): CommitPromptFile[] => {
    switch (file.status) {
      case 'A':
      case '?':
        return [{ path: file.path, status: 'added' }];
      case 'M':
        return [{ path: file.path, status: 'modified' }];
      case 'D':
        return [{ path: file.path, status: 'deleted' }];
      case 'C':
      default:
        return [];
    }
  });
}

export function buildSelectedCommitPrompt(files: CommitPromptFile[]): string {
  const formatted = formatFileSection('Here are the files selected for this commit:', files);
  let message = COMMIT_PROMPT_PREFIX;
  message += `\n\n${formatted.section}`;
  message += formatExcludedFileNotice(formatted.excludedFileCount);
  message += formatted.fileList
    ? '\n\nCommit exactly these files and add nothing else. Read the diffs for these files before proposing the commit message.' +
      '\n\nThen call developer_git_commit_proposal with exactly this file list.'
    : '\n\nNo safely representable file paths remain. Do not create a commit proposal.';
  message += '\nDo NOT call get_session_edited_files or get_workstream_edited_files -- the file data is already provided above.';
  return message;
}
