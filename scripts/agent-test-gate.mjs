#!/usr/bin/env node
// Test gate for AI-agent commits. Wired as a Claude Code PreToolUse hook on the
// git commit-proposal tool (see .claude/settings.json): before an agent commits,
// run typecheck + the non-provider unit suite. A non-zero exit blocks the commit
// and feeds the failure back to the agent.
//
// To keep docs-only / config-only commits fast, it first checks whether any
// source or test file actually changed; if not, it exits 0 without running.
import { execFileSync } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function changedFiles() {
  try {
    const tracked = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      encoding: 'utf8',
    });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf8',
    });
    return `${tracked}\n${untracked}`
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // Not a git repo / git unavailable: don't block the agent.
    return [];
  }
}

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IGNORE = /(^|\/)(node_modules|dist|out|out2|\.vite|coverage)\//;

const codeChanges = changedFiles().filter((f) => CODE.test(f) && !IGNORE.test(f));

if (codeChanges.length === 0) {
  // No code touched — nothing to verify.
  process.exit(0);
}

console.error(
  `[test-gate] ${codeChanges.length} code file(s) changed; running typecheck + unit tests before commit...`,
);

try {
  execFileSync(npm, ['run', 'typecheck'], { stdio: 'inherit' });
  execFileSync(npm, ['run', 'test:prepush'], { stdio: 'inherit' });
} catch {
  console.error('[test-gate] BLOCKED: typecheck or unit tests failed. Fix them before committing.');
  process.exit(2);
}

console.error('[test-gate] typecheck + unit tests passed.');
process.exit(0);
