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
  /**
   * The repo that owns this file, when the workspace spans more than one. A
   * commit cannot cross repos, so the prompt groups on this and asks for one
   * proposal per repo; a flat list left the agent no way to know it needed
   * several calls, and the split happened invisibly at execution instead.
   */
  repo?: string;
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
/** Group header for files that belong to no repo when the list spans repos. */
export const NO_REPOSITORY_GROUP_HEADER = 'Not in any repository:';
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
    fileList: formatSafeFileRows(safeFiles),
    excludedFileCount: files.length - safeFiles.length,
  };
}

/**
 * Distinct repos across a file list, in first-seen order. Files with no `repo`
 * are ignored: a workspace whose files carry no repo at all is the ordinary
 * single-repo case and must render exactly as it always has.
 */
export function distinctRepos(files: CommitPromptFile[]): string[] {
  const seen = new Set<string>();
  for (const file of files) {
    if (file.repo) seen.add(file.repo);
  }
  return [...seen];
}

function formatSafeFileRows(safeFiles: CommitPromptFile[]): string {
  const repos = distinctRepos(safeFiles);
  const row = (file: CommitPromptFile) => `- ${file.path} (${file.status})`;

  // One repo (or none identified) keeps the flat list every existing prompt,
  // card parser, and test already expects.
  if (repos.length < 2) {
    return safeFiles.map(row).join('\n');
  }

  const grouped = repos.map((repo) => {
    const rows = safeFiles.filter((file) => file.repo === repo).map(row).join('\n');
    return `Repository: ${repo}\n${rows}`;
  });
  // Files in no repo still have to be listed, or the agent silently loses them.
  const orphans = safeFiles.filter((file) => !file.repo).map(row).join('\n');
  return [...grouped, ...(orphans ? [`${NO_REPOSITORY_GROUP_HEADER}\n${orphans}`] : [])].join('\n\n');
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

/**
 * Instruction for a file list spanning repos. Empty for the single-repo case,
 * so an ordinary commit prompt is byte-identical to before.
 */
function formatMultiRepoNotice(files: CommitPromptFile[]): string {
  const repos = distinctRepos(files);
  if (repos.length < 2) return '';
  return `\n\nThese files span ${repos.length} git repositories, and a commit cannot cross repositories. ` +
    'Call developer_git_commit_proposal once per repository, each with only that repository\'s files ' +
    'and a commit message describing that repository\'s change. A call whose files span repositories is rejected.';
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
      message += formatMultiRepoNotice(commitContext.files);
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
      message += '\n\nThis list includes recorded edits and may include inferred shell edits. File links do not establish exclusive ownership of a whole-file diff. ' +
        'Review the listed diffs against this session\'s work before committing. Shell tracking can miss ambiguous, delayed, or external writes; ' +
        'if commands changed additional files, check git status for those paths. Do NOT add unrelated changes from other sessions.';
      message += formatted.fileList
        ? '\n\nThen call developer_git_commit_proposal with the file list.'
        : '\n\nNo safely representable file paths remain. Do not create a commit proposal.';
      message += formatMultiRepoNotice(commitContext.files);
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

export function buildSelectedCommitPrompt(files: CommitPromptFile[], repoPath?: string): string {
  const formatted = formatFileSection('Here are the files selected for this commit:', files);
  let message = COMMIT_PROMPT_PREFIX;
  message += `\n\n${formatted.section}`;
  message += formatExcludedFileNotice(formatted.excludedFileCount);
  message += formatted.fileList
    ? '\n\nCommit exactly these files and add nothing else. Read the diffs for these files before proposing the commit message.' +
      // The picker chose this repo, so the proposal must target it. Without
      // saying so the agent can propose files the picker never showed.
      (repoPath ? `\n\nThese files are all in the repository ${repoPath}. Make one commit proposal for that repository and no other.` : '') +
      '\n\nThen call developer_git_commit_proposal with exactly this file list.'
    : '\n\nNo safely representable file paths remain. Do not create a commit proposal.';
  message += '\nDo NOT call get_session_edited_files or get_workstream_edited_files -- the file data is already provided above.';
  return message;
}
