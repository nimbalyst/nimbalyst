/**
 * NIM-806 Phase 4 (Direction A) — pure-builder contract for the genuine
 * `claude-code-cli` tool-permission flow. Locks the two contracts that must be
 * exact:
 *   1. the Claude Code `--permission-prompt-tool` RETURN shape
 *      (`{behavior:'allow',updatedInput}` | `{behavior:'deny',message}`), and
 *   2. the synthetic `nimbalyst_tool_use` (name `ToolPermission`) input the real
 *      `ToolPermissionWidget` reads.
 * Plus the per-session approved-pattern cache that makes Session/Always actually
 * suppress re-prompts for the external CLI (no in-process provider holds it).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseToolPermissionRequestArgs,
  buildToolPermissionRequest,
  buildToolPermissionWidgetInput,
  buildToolPermissionBehaviorResult,
  buildToolPermissionResultPayload,
  buildToolPermissionResponseRecord,
  parseToolPermissionResponseRecord,
  toToolPermissionMcpResult,
  resolveClaudeCliToolPermission,
  decideAutoPermission,
  type ToolPermissionAnswer,
  type ToolPermissionDeps,
} from '../claudeCliToolPermission';
import {
  markPatternApproved,
  isPatternApproved,
  clearApprovedPatterns,
} from '../claudeCliPermissionCache';

describe('parseToolPermissionRequestArgs', () => {
  it('reads tool_name + input (CLI snake_case shape)', () => {
    const { toolName, input } = parseToolPermissionRequestArgs({
      tool_name: 'Write',
      input: { file_path: '/w/a.txt', content: 'hi' },
    });
    expect(toolName).toBe('Write');
    expect(input).toEqual({ file_path: '/w/a.txt', content: 'hi' });
  });

  it('tolerates camelCase toolName and legacy tool_input, defaults safely', () => {
    expect(parseToolPermissionRequestArgs({ toolName: 'Bash', tool_input: { command: 'ls' } }))
      .toEqual({ toolName: 'Bash', input: { command: 'ls' } });
    expect(parseToolPermissionRequestArgs(undefined)).toEqual({ toolName: '', input: {} });
    expect(parseToolPermissionRequestArgs({ tool_name: 'Read', input: 'not-an-object' }))
      .toEqual({ toolName: 'Read', input: {} });
  });
});

describe('buildToolPermissionRequest', () => {
  it('derives pattern/description/destructive for a Write', () => {
    const req = buildToolPermissionRequest('Write', { file_path: '/w/new.ts', content: 'x' });
    expect(req.pattern).toBe('Write');
    expect(req.isDestructive).toBe(true);
    expect(req.rawCommand).toBe('write /w/new.ts');
  });

  it('uses the raw command for Bash and the git-subcommand pattern', () => {
    const req = buildToolPermissionRequest('Bash', { command: 'git status --short' });
    expect(req.pattern).toBe('Bash(git status:*)');
    expect(req.isDestructive).toBe(true);
    expect(req.rawCommand).toBe('git status --short');
  });

  it('marks a read-only tool non-destructive', () => {
    const req = buildToolPermissionRequest('Read', { file_path: '/w/a.ts' });
    expect(req.isDestructive).toBe(false);
  });
});

describe('buildToolPermissionWidgetInput', () => {
  it('produces the exact field set ToolPermissionWidget reads', () => {
    const req = buildToolPermissionRequest('Bash', { command: 'rm -rf build' });
    const input = buildToolPermissionWidgetInput({
      requestId: 'tool-perm-1',
      request: req,
      workspacePath: '/w',
    });
    expect(input).toMatchObject({
      requestId: 'tool-perm-1',
      toolName: 'Bash',
      rawCommand: 'rm -rf build',
      pattern: 'Bash(rm:*)',
      isDestructive: true,
      warnings: [],
      workspacePath: '/w',
    });
    expect(typeof (input as any).patternDisplayName).toBe('string');
    expect('teammateName' in input).toBe(false);
  });
});

describe('buildToolPermissionBehaviorResult (CLI return contract)', () => {
  const input = { file_path: '/w/a.ts', content: 'x' };

  it('allow → {behavior:"allow", updatedInput:<input>}', () => {
    expect(buildToolPermissionBehaviorResult({ decision: 'allow', scope: 'once' }, input))
      .toEqual({ behavior: 'allow', updatedInput: input });
  });

  it('deny → {behavior:"deny", message}', () => {
    const r = buildToolPermissionBehaviorResult({ decision: 'deny', scope: 'once' }, input);
    expect(r.behavior).toBe('deny');
    expect((r as any).message).toContain('denied');
  });

  it('cancelled allow is treated as deny', () => {
    const r = buildToolPermissionBehaviorResult({ decision: 'allow', scope: 'once', cancelled: true }, input);
    expect(r.behavior).toBe('deny');
    expect((r as any).message).toContain('cancelled');
  });

  it('wraps as MCP text content (isError false even for deny)', () => {
    const behavior = buildToolPermissionBehaviorResult({ decision: 'deny', scope: 'once' }, input);
    const mcp = toToolPermissionMcpResult(behavior);
    expect(mcp.isError).toBe(false);
    expect(JSON.parse(mcp.content[0].text)).toEqual(behavior);
  });
});

describe('buildToolPermissionResultPayload (widget completed state)', () => {
  it('carries decision/scope/cancelled', () => {
    expect(buildToolPermissionResultPayload({ decision: 'allow', scope: 'session' }))
      .toEqual({ decision: 'allow', scope: 'session', cancelled: false });
  });
});

describe('permission_response records (mobile/DB fallback contract)', () => {
  it('builds the durable response row shape mobile and desktop persist', () => {
    expect(buildToolPermissionResponseRecord({
      requestId: 'tool-perm-1',
      answer: { decision: 'allow', scope: 'always-all' },
      respondedBy: 'mobile',
      respondedAt: 123,
    })).toEqual({
      type: 'permission_response',
      requestId: 'tool-perm-1',
      decision: 'allow',
      scope: 'always-all',
      cancelled: false,
      respondedAt: 123,
      respondedBy: 'mobile',
    });
  });

  it('parses only the matching permission_response row into a ToolPermissionAnswer', () => {
    const row = buildToolPermissionResponseRecord({
      requestId: 'tool-perm-1',
      answer: { decision: 'deny', scope: 'once', cancelled: true },
      respondedBy: 'desktop',
      respondedAt: 456,
    });

    expect(parseToolPermissionResponseRecord(JSON.stringify(row), 'tool-perm-1'))
      .toEqual({ decision: 'deny', scope: 'once', cancelled: true });
    expect(parseToolPermissionResponseRecord(JSON.stringify(row), 'other-id')).toBeNull();
    expect(parseToolPermissionResponseRecord('not json', 'tool-perm-1')).toBeNull();
  });
});

describe('claudeCliPermissionCache', () => {
  const sessionId = 'perm-cache-session';
  beforeEach(() => clearApprovedPatterns(sessionId));

  it('exact and prefix-wildcard approvals suppress re-prompts', () => {
    expect(isPatternApproved(sessionId, 'Write')).toBe(false);
    markPatternApproved(sessionId, 'Write');
    expect(isPatternApproved(sessionId, 'Write')).toBe(true);

    // A broad git approval covers a more specific later request.
    markPatternApproved(sessionId, 'Bash(git:*)');
    expect(isPatternApproved(sessionId, 'Bash(git status:*)')).toBe(true);
    // But not an unrelated command.
    expect(isPatternApproved(sessionId, 'Bash(rm:*)')).toBe(false);
  });

  it('never caches compound one-time patterns', () => {
    markPatternApproved(sessionId, 'Bash:compound:12345');
    expect(isPatternApproved(sessionId, 'Bash:compound:12345')).toBe(false);
  });
});

describe('decideAutoPermission (workspace mode + settings)', () => {
  const base = { toolName: 'Write', pattern: 'Write', sessionCacheHit: false, allowList: [] as string[], denyList: [] as string[] };

  it('bypass-all allows everything (even Bash, even deny-listed)', () => {
    expect(decideAutoPermission({ ...base, mode: 'bypass-all', toolName: 'Bash', pattern: 'Bash(rm:*)' })).toBe('allow');
    expect(decideAutoPermission({ ...base, mode: 'bypass-all', denyList: ['Bash(rm:*)'], toolName: 'Bash', pattern: 'Bash(rm:*)' })).toBe('allow');
  });

  it('allow-all auto-approves file edits but still prompts for Bash/WebFetch', () => {
    expect(decideAutoPermission({ ...base, mode: 'allow-all', toolName: 'Write', pattern: 'Write' })).toBe('allow');
    expect(decideAutoPermission({ ...base, mode: 'allow-all', toolName: 'Edit', pattern: 'Edit' })).toBe('allow');
    expect(decideAutoPermission({ ...base, mode: 'allow-all', toolName: 'Bash', pattern: 'Bash(ls:*)' })).toBe('ask');
    expect(decideAutoPermission({ ...base, mode: 'allow-all', toolName: 'WebFetch', pattern: 'WebFetch(domain:x.com)' })).toBe('ask');
  });

  it('ask mode (or untrusted) prompts for an uncached, unlisted tool', () => {
    expect(decideAutoPermission({ ...base, mode: 'ask' })).toBe('ask');
    expect(decideAutoPermission({ ...base, mode: null })).toBe('ask');
  });

  it('session cache and settings allow-list short-circuit to allow', () => {
    expect(decideAutoPermission({ ...base, mode: 'ask', sessionCacheHit: true })).toBe('allow');
    expect(decideAutoPermission({ ...base, mode: 'ask', toolName: 'Bash', pattern: 'Bash(git status:*)', allowList: ['Bash(git:*)'] })).toBe('allow');
  });

  it('deny-list denies (outside bypass-all)', () => {
    expect(decideAutoPermission({ ...base, mode: 'ask', toolName: 'Bash', pattern: 'Bash(rm:*)', denyList: ['Bash(rm:*)'] })).toBe('deny');
  });
});

describe('resolveClaudeCliToolPermission (round-trip)', () => {
  const sessionId = 'cli-perm-rt';
  const workspacePath = '/w';

  // Build a deps harness with sensible spies; override per-test.
  function makeDeps(overrides: Partial<ToolPermissionDeps> = {}): {
    deps: ToolPermissionDeps;
    spies: Record<string, ReturnType<typeof vi.fn>>;
  } {
    const spies = {
      isPatternApproved: vi.fn(() => false),
      markPatternApproved: vi.fn(),
      persistToolUse: vi.fn(async () => {}),
      persistToolResult: vi.fn(async () => {}),
      setWaitingStatus: vi.fn(),
      applySettle: vi.fn(),
      savePattern: vi.fn(async () => {}),
      notifyBlocked: vi.fn(),
      makeRequestId: vi.fn(() => 'tool-perm-fixed'),
    };
    const deps: ToolPermissionDeps = {
      ...spies,
      waitForAnswer: overrides.waitForAnswer ?? (async () => ({ decision: 'allow', scope: 'once' }) as ToolPermissionAnswer),
      ...overrides,
    } as ToolPermissionDeps;
    return { deps, spies };
  }

  it('renders the widget and returns allow with updatedInput when answered allow/once', async () => {
    const { deps, spies } = makeDeps({
      waitForAnswer: async () => ({ decision: 'allow', scope: 'once' }),
    });
    const input = { file_path: '/w/new.ts', content: 'x' };
    const result = await resolveClaudeCliToolPermission(
      { args: { tool_name: 'Write', input }, sessionId, workspacePath },
      deps,
    );

    // Widget rendered (synthetic tool_use), waiting status set, completed result persisted.
    expect(spies.persistToolUse).toHaveBeenCalledTimes(1);
    expect(spies.persistToolUse.mock.calls[0][0].input).toMatchObject({
      requestId: 'tool-perm-fixed', toolName: 'Write', pattern: 'Write', isDestructive: true,
    });
    expect(spies.setWaitingStatus).toHaveBeenCalledWith(sessionId);
    expect(spies.persistToolResult).toHaveBeenCalledTimes(1);
    expect(spies.persistToolResult.mock.calls[0][0].result).toMatchObject({ decision: 'allow', scope: 'once' });
    expect(spies.applySettle).toHaveBeenCalledWith(
      sessionId,
      'tool-perm-fixed',
      expect.objectContaining({ decision: 'allow', scope: 'once' }),
    );

    // once → not cached, not saved.
    expect(spies.markPatternApproved).not.toHaveBeenCalled();
    expect(spies.savePattern).not.toHaveBeenCalled();

    // Return is the CLI permission contract.
    expect(JSON.parse(result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: input });
    expect(result.isError).toBe(false);
  });

  it('still settles the prompt when result persistence fails', async () => {
    const persistToolResult = vi.fn(async () => {
      throw new Error('result store unavailable');
    });
    const { deps, spies } = makeDeps({ persistToolResult });

    await expect(resolveClaudeCliToolPermission(
      {
        args: { tool_name: 'Write', input: { file_path: '/w/new.ts', content: 'x' } },
        sessionId,
        workspacePath,
      },
      deps,
    )).rejects.toThrow('result store unavailable');

    expect(spies.applySettle).toHaveBeenCalledWith(
      sessionId,
      'tool-perm-fixed',
      expect.objectContaining({ decision: 'allow', scope: 'once' }),
    );
  });

  it('allow-all workspace auto-approves a Write with NO widget (the reported bug)', async () => {
    const waitForAnswer = vi.fn(async () => ({ decision: 'deny', scope: 'once' }) as ToolPermissionAnswer);
    const { deps, spies } = makeDeps({
      getPermissionMode: () => 'allow-all',
      waitForAnswer,
    });
    const input = { file_path: '/w/a.ts', content: 'x' };
    const result = await resolveClaudeCliToolPermission(
      { args: { tool_name: 'Write', input }, sessionId, workspacePath },
      deps,
    );
    expect(spies.persistToolUse).not.toHaveBeenCalled();
    expect(spies.setWaitingStatus).not.toHaveBeenCalled();
    expect(waitForAnswer).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: input });
  });

  it('allow-all workspace STILL renders the widget for Bash', async () => {
    const { deps, spies } = makeDeps({
      getPermissionMode: () => 'allow-all',
      waitForAnswer: async () => ({ decision: 'allow', scope: 'once' }),
    });
    await resolveClaudeCliToolPermission(
      { args: { tool_name: 'Bash', input: { command: 'ls' } }, sessionId, workspacePath },
      deps,
    );
    expect(spies.persistToolUse).toHaveBeenCalledTimes(1);
  });

  it('settings allow-list (cross-session Always) auto-approves with NO widget', async () => {
    const { deps, spies } = makeDeps({
      getAllowDenyLists: async () => ({ allow: ['Bash(git:*)'], deny: [] }),
      waitForAnswer: async () => ({ decision: 'deny', scope: 'once' }),
    });
    const result = await resolveClaudeCliToolPermission(
      { args: { tool_name: 'Bash', input: { command: 'git status' } }, sessionId, workspacePath },
      deps,
    );
    expect(spies.persistToolUse).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).behavior).toBe('allow');
  });

  it('auto-allows a cached pattern with NO widget or waiting state', async () => {
    const waitForAnswer = vi.fn(async () => ({ decision: 'deny', scope: 'once' }) as ToolPermissionAnswer);
    const { deps, spies } = makeDeps({
      isPatternApproved: vi.fn(() => true),
      waitForAnswer,
    });
    const input = { command: 'git status' };
    const result = await resolveClaudeCliToolPermission(
      { args: { tool_name: 'Bash', input }, sessionId, workspacePath },
      deps,
    );
    expect(spies.persistToolUse).not.toHaveBeenCalled();
    expect(spies.setWaitingStatus).not.toHaveBeenCalled();
    expect(waitForAnswer).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: input });
  });

  it('caches the pattern for session scope (no settings write)', async () => {
    const { deps, spies } = makeDeps({
      waitForAnswer: async () => ({ decision: 'allow', scope: 'session' }),
    });
    await resolveClaudeCliToolPermission(
      { args: { tool_name: 'Bash', input: { command: 'npm test' } }, sessionId, workspacePath },
      deps,
    );
    expect(spies.markPatternApproved).toHaveBeenCalledWith(sessionId, 'Bash(npm test:*)');
    expect(spies.savePattern).not.toHaveBeenCalled();
  });

  it('caches AND saves to settings for always scope', async () => {
    const { deps, spies } = makeDeps({
      waitForAnswer: async () => ({ decision: 'allow', scope: 'always' }),
    });
    await resolveClaudeCliToolPermission(
      { args: { tool_name: 'Edit', input: { file_path: '/w/a.ts' } }, sessionId, workspacePath },
      deps,
    );
    expect(spies.markPatternApproved).toHaveBeenCalledWith(sessionId, 'Edit');
    expect(spies.savePattern).toHaveBeenCalledWith(workspacePath, 'Edit');
  });

  it('returns deny (and never caches) when the user denies', async () => {
    const { deps, spies } = makeDeps({
      waitForAnswer: async () => ({ decision: 'deny', scope: 'once' }),
    });
    const result = await resolveClaudeCliToolPermission(
      { args: { tool_name: 'Bash', input: { command: 'rm -rf /' } }, sessionId, workspacePath },
      deps,
    );
    expect(spies.markPatternApproved).not.toHaveBeenCalled();
    expect(spies.persistToolResult.mock.calls[0][0].result).toMatchObject({ decision: 'deny' });
    expect(spies.persistToolResult.mock.calls[0][0].isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.behavior).toBe('deny');
  });

  it('fails closed (deny) when the wait rejects (e.g. abort)', async () => {
    const { deps } = makeDeps({
      waitForAnswer: async () => { throw new Error('aborted'); },
    });
    const result = await resolveClaudeCliToolPermission(
      { args: { tool_name: 'Bash', input: { command: 'curl evil' } }, sessionId, workspacePath },
      deps,
    );
    expect(JSON.parse(result.content[0].text).behavior).toBe('deny');
  });
});
