import { describe, it, expect } from 'vitest';
import { isCommitRequestMessage, parseCommitRequest } from '../CommitRequestCard';

// Mirrors the prompt that GitOperationsPanel / voiceModeListeners build for the
// files-present branch. The exact "call the tool" sentence is reworded over time;
// the widget must keep recognizing the message regardless of that wording.
function buildCommitPrompt(fileList: string): string {
  let message = 'Use the developer_git_commit_proposal tool to create a commit.';
  message += `\n\nHere are the files edited in this session that have uncommitted changes:\n${fileList}`;
  message += '\n\nThis list only covers files edited directly. It may be missing side-effect files. ' +
    'Run git status --porcelain and add any such uncommitted side-effect files that clearly belong.';
  message += '\n\nThen call developer_git_commit_proposal with the combined file list.';
  return message;
}

// Mirrors the worktree branch GitOperationsPanel builds: all uncommitted changes in
// the worktree, not just the current session's edits.
function buildWorktreeCommitPrompt(fileList: string): string {
  let message = 'Use the developer_git_commit_proposal tool to create a commit.';
  message += `\n\nHere are all the uncommitted changes in this worktree:\n${fileList}`;
  message += '\n\nThis is the complete set of uncommitted changes in this worktree. ' +
    'A worktree is dedicated to a single line of work, so include all of these files in the commit.';
  message += '\n\nThen call developer_git_commit_proposal with the file list.';
  message += '\n\nThis work is on a worktree branch. Consider the full set of changes on this branch.';
  return message;
}

describe('isCommitRequestMessage', () => {
  it('detects the reworded commit prompt (no "immediately" phrasing)', () => {
    const text = buildCommitPrompt('- src/index.ts (modified)');
    expect(isCommitRequestMessage(text)).toBe(true);
  });

  it('does not match the no-files branch', () => {
    const text = 'Use the developer_git_commit_proposal tool to create a commit.\n\n' +
      'No session-edited files have uncommitted changes. Check git status to see if there are any other uncommitted changes to commit.';
    expect(isCommitRequestMessage(text)).toBe(false);
  });

  it('does not match unrelated user messages', () => {
    expect(isCommitRequestMessage('Please commit my changes')).toBe(false);
  });

  it('detects the worktree "all uncommitted changes" prompt', () => {
    const text = buildWorktreeCommitPrompt('- src/index.ts (modified)');
    expect(isCommitRequestMessage(text)).toBe(true);
  });
});

describe('parseCommitRequest', () => {
  it('parses the injected file list from the reworded prompt', () => {
    const fileList = ['- package.json (modified)', '- package-lock.json (modified)'].join('\n');
    const parsed = parseCommitRequest(buildCommitPrompt(fileList));
    expect(parsed).not.toBeNull();
    expect(parsed!.files).toEqual([
      { path: 'package.json', status: 'modified' },
      { path: 'package-lock.json', status: 'modified' },
    ]);
    expect(parsed!.scenario).toBe('single');
  });

  it('parses the worktree prompt and flags it as a worktree commit', () => {
    const fileList = ['- a.ts (modified)', '- b.ts (added)', '- c.ts (deleted)'].join('\n');
    const parsed = parseCommitRequest(buildWorktreeCommitPrompt(fileList));
    expect(parsed).not.toBeNull();
    expect(parsed!.files).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'added' },
      { path: 'c.ts', status: 'deleted' },
    ]);
    expect(parsed!.scenario).toBe('single');
    expect(parsed!.isWorktree).toBe(true);
  });
});
