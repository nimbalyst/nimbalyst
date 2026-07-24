/**
 * Shared utilities for tool permission handling
 *
 * These functions are used by both ClaudeCodeProvider and ToolPermissionService
 * to generate tool descriptions and patterns for permission requests.
 */

import { hasShellChainingOperators } from './BashCommandAnalyzer';

/**
 * Build a human-readable description of a tool call for permission UI
 *
 * @param toolName - Name of the tool being called
 * @param input - Tool input parameters
 * @returns Human-readable description string
 */
export function buildToolDescription(toolName: string, input: any): string {
  switch (toolName) {
    case 'Read':
      return input?.file_path ? `read ${input.file_path}` : '';
    case 'Write':
      return input?.file_path ? `write ${input.file_path}` : '';
    case 'Edit':
      return input?.file_path ? `edit ${input.file_path}` : '';
    case 'MultiEdit':
      return input?.edits?.length ? `multi-edit ${input.edits.length} files` : '';
    case 'Glob':
      return input?.pattern ? `glob ${input.pattern}` : '';
    case 'Grep':
      return input?.pattern ? `grep ${input.pattern}` : '';
    case 'Task':
      return input?.description || input?.prompt?.slice(0, 50) || 'spawn task';
    case 'WebFetch':
      return input?.url ? `fetch ${input.url}` : '';
    case 'WebSearch':
      return input?.query ? `search "${input.query}"` : '';
    case 'TodoWrite':
      return 'update todos';
    case 'KillShell':
      return input?.shell_id ? `kill shell ${input.shell_id}` : '';
    case 'MCPSearch':
      return input?.query ? `search MCP tools: ${input.query}` : '';
    default:
      // For MCP tools (mcp__*) and other unknown tools, create a generic description
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const serverName = parts[1] || 'unknown';
        const mcpToolName = parts[2] || 'unknown';
        return `${serverName}:${mcpToolName}`;
      }
      // For completely unknown tools, just return the tool name
      return toolName;
  }
}

/**
 * Generate a tool pattern for Claude Code's allowedTools format.
 * These patterns are written to .claude/settings.local.json when user approves with "Always".
 *
 * Pattern strategy:
 * - git: include subcommand for granularity (git diff, git commit, etc.)
 * - npm/npx: include subcommand (npm run, npm test, npx vitest, etc.)
 * - everything else: just base command (ls, cat, grep, etc.)
 *
 * We never include paths/filenames - patterns match any invocation of the command.
 *
 * @param toolName - Name of the tool being called
 * @param input - Tool input parameters
 * @returns Permission pattern string
 */
export function generateToolPattern(toolName: string, input: any): string {
  switch (toolName) {
    case 'Bash': {
      const command = (input?.command as string) || '';

      // Detect compound commands - these should not be cached
      // because approving "git add" shouldn't auto-approve "git add && git commit"
      // Use quote-aware detection to avoid false positives on heredocs/quoted strings
      if (hasShellChainingOperators(command)) {
        // Return a unique pattern that won't match future commands
        return `Bash:compound:${Date.now()}`;
      }

      const words = command.trim().split(/\s+/);

      if (words.length === 0 || !words[0]) {
        return 'Bash';
      }

      const baseCommand = words[0];

      // For git, find the subcommand (skip flags like -C, --no-pager)
      // "git -C /path diff" -> "Bash(git diff:*)"
      // "git commit -m 'msg'" -> "Bash(git commit:*)"
      if (baseCommand === 'git') {
        for (let i = 1; i < words.length; i++) {
          const word = words[i];
          if (word.startsWith('-')) {
            // Skip flags that take arguments
            if (['-C', '-c', '--git-dir', '--work-tree'].includes(word)) {
              i++;
            }
            continue;
          }
          // First non-flag is the subcommand
          return `Bash(git ${word}:*)`;
        }
        return `Bash(git:*)`;
      }

      // For npm/npx, find the subcommand (skip flags like --prefix)
      if (baseCommand === 'npm' || baseCommand === 'npx') {
        for (let i = 1; i < words.length; i++) {
          const word = words[i];
          if (word.startsWith('-')) {
            if (['--prefix', '-w', '--workspace'].includes(word)) {
              i++;
            }
            continue;
          }
          return `Bash(${baseCommand} ${word}:*)`;
        }
        return `Bash(${baseCommand}:*)`;
      }

      // For everything else, just the base command
      // "ls -la /some/path" -> "Bash(ls:*)"
      // "cat /etc/passwd" -> "Bash(cat:*)"
      return `Bash(${baseCommand}:*)`;
    }

    case 'WebFetch': {
      // Extract domain for pattern matching
      const url = (input?.url as string) || '';
      try {
        const parsedUrl = new URL(url);
        return `WebFetch(domain:${parsedUrl.hostname})`;
      } catch {
        return 'WebFetch';
      }
    }

    case 'WebSearch':
      return 'WebSearch';

    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'Glob':
    case 'Grep':
    case 'LS':
    case 'TodoRead':
    case 'TodoWrite':
    case 'Task':
    case 'NotebookRead':
    case 'NotebookEdit':
    case 'ExitPlanMode':
      return toolName;

    default:
      // MCP tools: mcp__server__tool - use as-is
      if (toolName.startsWith('mcp__')) {
        return toolName;
      }
      return toolName;
  }
}

/**
 * Returns true if a runtime tool pattern is covered by an entry in the
 * Claude allow list (the `permissions.allow` array in `~/.claude/settings.json`,
 * `.claude/settings.json`, or `.claude/settings.local.json`).
 *
 * Claude Code's allow patterns are prefix-wildcards, not exact strings:
 * - `Bash(git:*)` covers any `Bash(git X:*)` (e.g. `Bash(git status:*)`)
 * - `Bash(git diff:*)` covers `Bash(git diff:*)` but not `Bash(git status:*)`
 * - `WebFetch` (bare tool name, no parens) covers every `WebFetch(...)` call
 * - `mcp__server` covers every tool under that MCP server
 * - `mcp__server__tool` covers only that specific MCP tool
 *
 * Nimbalyst's runtime patterns are always the most specific form, e.g.
 * `Bash(git status:*)` or `WebFetch(domain:example.com)`, so the old exact
 * `Array.prototype.includes` check missed the prefix-wildcard case and the
 * user kept seeing dialogs for tools they had already approved globally.
 * Fixes nimbalyst#152.
 *
 * Word-boundary prefix matching prevents `Bash(npm:*)` from accidentally
 * covering a hypothetical `Bash(npmrc:*)` candidate: the allow command must
 * either equal the candidate command exactly OR be followed by a space in
 * the candidate.
 *
 * @param candidate - The runtime pattern Nimbalyst built for the current
 *   tool call (e.g. `Bash(git status:*)`).
 * @param allowed - One entry from the user's `permissions.allow` array
 *   (e.g. `Bash(git:*)`, `WebFetch`, `mcp__github`).
 * @returns true if the candidate should be treated as approved.
 */
export function matchesAllowPattern(candidate: string, allowed: string): boolean {
  if (candidate === allowed) return true;
  if (!allowed) return false;

  const stripWildcardSuffix = (s: string): string =>
    s.endsWith(':*') ? s.slice(0, -2) : s;

  // Bare tool name in allow list (`WebFetch`, `mcp__github`, `Task`).
  // Matches any candidate whose tool name (text before `(`) equals the
  // allowed entry, or whose name starts with `allowed + '__'` for MCP
  // server-wide allows.
  if (!allowed.includes('(')) {
    const candidateToolName = candidate.split('(')[0];
    if (candidateToolName === allowed) return true;
    if (
      allowed.startsWith('mcp__') &&
      candidateToolName.startsWith(allowed + '__')
    ) {
      return true;
    }
    return false;
  }

  // Both patterns have a parenthesized command. Split into tool + command.
  // Greedy match on the inner so commands containing `)` (e.g. shell
  // substitution `$(date)`) round-trip through the same regex.
  const allowedMatch = allowed.match(/^([^(]+)\((.*)\)$/);
  const candidateMatch = candidate.match(/^([^(]+)\((.*)\)$/);
  if (!allowedMatch || !candidateMatch) return false;

  const [, allowedTool, allowedRawCmd] = allowedMatch;
  const [, candidateTool, candidateRawCmd] = candidateMatch;

  if (allowedTool !== candidateTool) return false;

  const allowedCmd = stripWildcardSuffix(allowedRawCmd);
  const candidateCmd = stripWildcardSuffix(candidateRawCmd);

  if (allowedCmd === candidateCmd) return true;

  // Word-boundary prefix match: `git` covers `git status`, `npm` does NOT
  // cover `npmrc`. The trailing space in the prefix is the boundary check.
  return candidateCmd.startsWith(allowedCmd + ' ');
}
