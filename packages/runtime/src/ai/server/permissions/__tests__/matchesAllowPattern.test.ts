import { describe, it, expect } from 'vitest';
import { matchesAllowPattern } from '../toolPermissionHelpers';

// Regression coverage for nimbalyst#152. tsahilevi and Lawrence-Dawson both
// reported that permission dialogs kept appearing for tools that were
// pre-approved in their global `~/.claude/settings.json` allow list. Root
// cause: the patternChecker used `Array.prototype.includes(pattern)` which
// only handles exact-string equality, but Claude Code allow patterns are
// prefix-wildcards. A user with `Bash(git:*)` in their global allow list
// kept seeing dialogs for `Bash(git status:*)`, `Bash(git push:*)`, etc.
// because the runtime-built pattern is the specific-subcommand form.

describe('matchesAllowPattern (issue #152)', () => {
  describe('exact matches', () => {
    it('returns true for identical patterns', () => {
      expect(matchesAllowPattern('Bash(git:*)', 'Bash(git:*)')).toBe(true);
      expect(matchesAllowPattern('WebFetch', 'WebFetch')).toBe(true);
      expect(matchesAllowPattern('mcp__github__list_issues', 'mcp__github__list_issues')).toBe(true);
    });
  });

  describe('Bash prefix-wildcard matching', () => {
    it('matches subcommand-specific candidates against generic Bash allows', () => {
      expect(matchesAllowPattern('Bash(git status:*)', 'Bash(git:*)')).toBe(true);
      expect(matchesAllowPattern('Bash(git push:*)', 'Bash(git:*)')).toBe(true);
      expect(matchesAllowPattern('Bash(npm install:*)', 'Bash(npm:*)')).toBe(true);
      expect(matchesAllowPattern('Bash(gh api:*)', 'Bash(gh:*)')).toBe(true);
    });

    it('matches deeper-subcommand candidates against subcommand allows', () => {
      // User allow-listed `git diff` but a `git diff --stat HEAD` call
      // generates the same `Bash(git diff:*)` pattern in Nimbalyst, so
      // exact equality already handles this case. The interesting one is
      // multi-word subcommands like `npm run build` against `npm run`.
      expect(matchesAllowPattern('Bash(npm run build:*)', 'Bash(npm run:*)')).toBe(true);
      expect(matchesAllowPattern('Bash(git submodule update:*)', 'Bash(git submodule:*)')).toBe(true);
    });

    it('rejects same-prefix but different command (word-boundary guard)', () => {
      // `npm` must NOT cover `npmrc` (no space between prefix and rest).
      expect(matchesAllowPattern('Bash(npmrc:*)', 'Bash(npm:*)')).toBe(false);
      // `gh` must NOT cover `ghi` even though strings prefix-match.
      expect(matchesAllowPattern('Bash(ghi:*)', 'Bash(gh:*)')).toBe(false);
    });

    it('rejects different tools entirely', () => {
      expect(matchesAllowPattern('Bash(npm:*)', 'Bash(git:*)')).toBe(false);
      expect(matchesAllowPattern('Bash(git:*)', 'Bash(npm:*)')).toBe(false);
    });
  });

  describe('bare-tool-name allow entries', () => {
    it('matches every WebFetch call against bare `WebFetch`', () => {
      expect(matchesAllowPattern('WebFetch(domain:example.com)', 'WebFetch')).toBe(true);
      expect(matchesAllowPattern('WebFetch(domain:github.com)', 'WebFetch')).toBe(true);
      expect(matchesAllowPattern('WebFetch', 'WebFetch')).toBe(true);
    });

    it('rejects a bare allow entry against a different tool', () => {
      expect(matchesAllowPattern('Bash(git:*)', 'WebFetch')).toBe(false);
      expect(matchesAllowPattern('WebSearch', 'WebFetch')).toBe(false);
    });
  });

  describe('MCP server-wide and tool-specific allows', () => {
    it('matches every tool under an MCP server against a server-wide allow', () => {
      expect(matchesAllowPattern('mcp__github__list_issues', 'mcp__github')).toBe(true);
      expect(matchesAllowPattern('mcp__github__create_pr', 'mcp__github')).toBe(true);
    });

    it('matches a specific MCP tool against its own allow entry', () => {
      expect(matchesAllowPattern('mcp__github__list_issues', 'mcp__github__list_issues')).toBe(true);
    });

    it('rejects a tool from a different MCP server', () => {
      expect(matchesAllowPattern('mcp__github__list_issues', 'mcp__linear')).toBe(false);
      expect(matchesAllowPattern('mcp__githubx__do_thing', 'mcp__github')).toBe(false);
    });
  });

  describe('candidate is broader than allow', () => {
    it('does NOT match when allow is more specific than candidate', () => {
      // Allow `Bash(git status:*)`, candidate is generic `Bash(git:*)` from
      // a separate session. The user explicitly approved only `git status`,
      // they should not be auto-allowed for plain `git`.
      expect(matchesAllowPattern('Bash(git:*)', 'Bash(git status:*)')).toBe(false);
    });
  });

  describe('malformed and edge inputs', () => {
    it('returns false for empty allow entries', () => {
      expect(matchesAllowPattern('Bash(git:*)', '')).toBe(false);
    });

    it('returns false when one side is malformed (unbalanced parens)', () => {
      expect(matchesAllowPattern('Bash(unbalanced', 'Bash(git:*)')).toBe(false);
      expect(matchesAllowPattern('Bash(git:*)', 'Bash(unbalanced')).toBe(false);
    });

    it('handles commands containing parens or special chars', () => {
      // Commands like `$(date)` should still flow through the regex (greedy
      // inner match captures the entire payload including any parens).
      expect(
        matchesAllowPattern('Bash(echo $(date):*)', 'Bash(echo:*)'),
      ).toBe(true);
    });
  });
});
