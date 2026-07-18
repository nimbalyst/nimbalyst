import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  encodeClaudeProjectDirName,
  resolveClaudeCliJsonlPath,
  shouldResumeClaudeCliSession,
} from '../claudeCliJsonlPath';

/**
 * Pure helpers behind the BUG 3 fix (NIM-806, Phase 3): the genuine `claude` CLI
 * rejects `--session-id <uuid>` once that id exists on disk, so on relaunch we
 * must switch to `--resume`. The resume decision is a pure function of whether
 * the CLI's deterministic per-session jsonl already exists.
 */
describe('claudeCliJsonlPath', () => {
  describe('encodeClaudeProjectDirName', () => {
    it('replaces path separators with dashes (leading slash → leading dash)', () => {
      // Verified live 2026-06-08 against the real failing session.
      expect(encodeClaudeProjectDirName('/Users/ghinkle/sources/stravu-editor')).toBe(
        '-Users-ghinkle-sources-stravu-editor',
      );
    });

    it('replaces EVERY non-alphanumeric char (incl. underscores) with a dash', () => {
      // Verified live: `…stravu-editor_worktrees/ample-wren` →
      // `…stravu-editor-worktrees-ample-wren` (the underscore became a dash too).
      expect(
        encodeClaudeProjectDirName('/Users/ghinkle/sources/stravu-editor_worktrees/ample-wren'),
      ).toBe('-Users-ghinkle-sources-stravu-editor-worktrees-ample-wren');
    });

    it('transforms dots as well (e.g. dotted dir names)', () => {
      expect(encodeClaudeProjectDirName('/a/b.c/d')).toBe('-a-b-c-d');
    });
  });

  describe('resolveClaudeCliJsonlPath', () => {
    it('builds ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl', () => {
      const homedir = path.resolve('/Users/ghinkle');
      const cwd = path.resolve('/Users/ghinkle/sources/stravu-editor');
      expect(resolveClaudeCliJsonlPath({
        homedir,
        cwd,
        sessionId: 'c261169b-d681-43e7-9c59-de4035b65cef',
      })).toBe(path.join(
        homedir,
        '.claude',
        'projects',
        encodeClaudeProjectDirName(cwd),
        'c261169b-d681-43e7-9c59-de4035b65cef.jsonl',
      ));
    });
  });

  describe('shouldResumeClaudeCliSession', () => {
    it('resumes when the jsonl already exists', () => {
      expect(shouldResumeClaudeCliSession({ jsonlExists: true })).toBe(true);
    });
    it('starts fresh when the jsonl does not exist', () => {
      expect(shouldResumeClaudeCliSession({ jsonlExists: false })).toBe(false);
    });
  });
});
