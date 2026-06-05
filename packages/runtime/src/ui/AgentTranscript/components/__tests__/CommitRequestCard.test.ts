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
});
