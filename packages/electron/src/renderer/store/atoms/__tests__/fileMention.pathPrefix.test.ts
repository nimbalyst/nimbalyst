/**
 * Regression tests for the workspace-prefix path check in fileMention.
 *
 * The @-mention picker filters the renderer's "recent files" list by
 * `isPathInsideWorkspace(absolutePath, workspaceRoot)` before showing it
 * on empty query. Before the #304 fix the check was hardcoded to
 * `path.startsWith(workspaceRoot + '/')` which dropped every file on
 * Windows (where absolute paths use `\` as the separator). The empty-
 * query path then fell through to the ripgrep search, which on empty
 * input returned alphabetical results.
 *
 * These tests pin both separators and the sibling-prefix collision case
 * (e.g. `/workspaces/foo` must NOT match a path under `/workspaces/foo-archive`).
 */
import { describe, it, expect } from 'vitest';
import { isPathInsideWorkspace } from '../workspacePathPrefix';

describe('isPathInsideWorkspace', () => {
  it('matches a POSIX path inside the workspace', () => {
    expect(isPathInsideWorkspace('/Users/karl/repos/app/src/main.ts', '/Users/karl/repos/app')).toBe(true);
  });

  it('matches a Windows path inside the workspace (regression for #304)', () => {
    expect(isPathInsideWorkspace(
      'C:\\Users\\karl\\repos\\app\\src\\main.ts',
      'C:\\Users\\karl\\repos\\app'
    )).toBe(true);
  });

  it('does not match a sibling workspace whose name shares the prefix (POSIX)', () => {
    // /workspaces/foo-archive must NOT be classified as inside /workspaces/foo
    expect(isPathInsideWorkspace(
      '/Users/karl/repos/app-archive/old.ts',
      '/Users/karl/repos/app'
    )).toBe(false);
  });

  it('does not match a sibling workspace whose name shares the prefix (Windows)', () => {
    expect(isPathInsideWorkspace(
      'C:\\Users\\karl\\repos\\app-archive\\old.ts',
      'C:\\Users\\karl\\repos\\app'
    )).toBe(false);
  });

  it('does not match a path from an unrelated workspace', () => {
    expect(isPathInsideWorkspace(
      '/Users/karl/repos/other/src/main.ts',
      '/Users/karl/repos/app'
    )).toBe(false);
  });

  it('matches the workspace root itself', () => {
    // Edge case: the workspace root path equals filePath. Treat as inside.
    expect(isPathInsideWorkspace('/Users/karl/repos/app', '/Users/karl/repos/app')).toBe(true);
  });

  it('handles trailing-separator workspace paths without a false positive', () => {
    // If a caller accidentally passes a trailing separator on the workspace
    // path, we still want the check to behave sanely. The current impl will
    // require the file to start with `workspacePath/` or `workspacePath\\`,
    // so a workspacePath ending in `/` produces a `//` prefix - any real
    // absolute path matches at most one of the two separators, never the
    // doubled one. Document the behavior so the test fails loudly if it
    // ever changes.
    const workspaceWithTrailing = '/Users/karl/repos/app/';
    expect(isPathInsideWorkspace('/Users/karl/repos/app/src/main.ts', workspaceWithTrailing)).toBe(false);
  });
});
