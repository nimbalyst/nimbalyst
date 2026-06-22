import { describe, it, expect, vi } from 'vitest';
import { resolveImmediateToolDecision, type ToolDecision } from '../immediateToolDecision';
import { INTERNAL_MCP_TOOLS } from '../toolPolicy';

function createDeps(overrides?: Partial<Parameters<typeof resolveImmediateToolDecision>[0]>) {
  return {
    internalMcpTools: ['mcp__nimbalyst-mcp__display_to_user', 'mcp__nimbalyst-mcp__capture_editor_screenshot'],
    teamTools: ['TeamCreate', 'TeamDelete', 'TeamList'],
    trustChecker: vi.fn().mockReturnValue({ trusted: true, mode: 'ask' }),
    resolveTeamContext: vi.fn().mockResolvedValue(undefined),
    handleAskUserQuestion: vi.fn().mockResolvedValue({ behavior: 'allow', updatedInput: {} }),
    handleExitPlanMode: vi.fn().mockResolvedValue({ behavior: 'allow', updatedInput: {} }),
    setCurrentMode: vi.fn(),
    logSecurity: vi.fn(),
    ...overrides,
  };
}

function createParams(overrides?: Partial<Parameters<typeof resolveImmediateToolDecision>[1]>) {
  return {
    toolName: 'Bash',
    input: { command: 'echo hello' },
    options: { signal: new AbortController().signal },
    sessionId: 'test-session',
    pathForTrust: '/test/workspace',
    ...overrides,
  };
}

function assertZodCompliantAllow(result: ToolDecision | null) {
  expect(result).not.toBeNull();
  expect(result!.behavior).toBe('allow');
  expect(result!.updatedInput).toBeDefined();
}

function assertZodCompliantDeny(result: ToolDecision | null) {
  expect(result).not.toBeNull();
  expect(result!.behavior).toBe('deny');
  expect(result!.message).toBeDefined();
  expect(typeof result!.message).toBe('string');
}

describe('resolveImmediateToolDecision', () => {
  describe('Zod schema compliance: allow always includes updatedInput', () => {
    it('internal MCP tool returns updatedInput', async () => {
      const deps = createDeps();
      const params = createParams({ toolName: 'mcp__nimbalyst-mcp__display_to_user', input: { chart: {} } });
      const result = await resolveImmediateToolDecision(deps, params);
      assertZodCompliantAllow(result);
      expect(result!.updatedInput).toEqual({ chart: {} });
    });

    it('team tool returns updatedInput', async () => {
      const deps = createDeps();
      const params = createParams({ toolName: 'TeamCreate', input: { team_name: 'alpha' } });
      const result = await resolveImmediateToolDecision(deps, params);
      assertZodCompliantAllow(result);
    });

    it('TeamDelete with inferred team context returns updatedInput with team_name', async () => {
      const deps = createDeps({ resolveTeamContext: vi.fn().mockResolvedValue('inferred-team') });
      const params = createParams({ toolName: 'TeamDelete', input: {} });
      const result = await resolveImmediateToolDecision(deps, params);
      assertZodCompliantAllow(result);
      expect(result!.updatedInput.team_name).toBe('inferred-team');
    });

    it('TeamDelete with explicit team_name returns updatedInput', async () => {
      const deps = createDeps();
      const params = createParams({ toolName: 'TeamDelete', input: { team_name: 'explicit' } });
      const result = await resolveImmediateToolDecision(deps, params);
      assertZodCompliantAllow(result);
    });

    it('bypass-all mode returns updatedInput (non-auto mode)', async () => {
      const deps = createDeps({
        trustChecker: vi.fn().mockReturnValue({ trusted: true, mode: 'bypass-all' }),
        getCurrentMode: () => 'agent',
      });
      const params = createParams({ toolName: 'Bash' });
      const result = await resolveImmediateToolDecision(deps, params);
      assertZodCompliantAllow(result);
    });

    it('allow-all mode with file tool returns updatedInput', async () => {
      const deps = createDeps({ trustChecker: vi.fn().mockReturnValue({ trusted: true, mode: 'allow-all' }) });
      const params = createParams({ toolName: 'Edit', input: { file_path: '/test/file.ts' } });
      const result = await resolveImmediateToolDecision(deps, params);
      assertZodCompliantAllow(result);
    });
  });

  describe('Zod schema compliance: deny always includes message', () => {
    it('untrusted workspace returns message', async () => {
      const deps = createDeps({ trustChecker: vi.fn().mockReturnValue({ trusted: false, mode: null }) });
      const params = createParams();
      const result = await resolveImmediateToolDecision(deps, params);
      assertZodCompliantDeny(result);
    });
  });

  describe('delegation to sub-handlers', () => {
    it('AskUserQuestion delegates to handleAskUserQuestion', async () => {
      const mockResult: ToolDecision = { behavior: 'allow', updatedInput: { answers: { q1: 'yes' } } };
      const deps = createDeps({ handleAskUserQuestion: vi.fn().mockResolvedValue(mockResult) });
      const params = createParams({ toolName: 'AskUserQuestion', input: { questions: [{ id: 'q1', text: 'proceed?' }] } });
      const result = await resolveImmediateToolDecision(deps, params);
      expect(deps.handleAskUserQuestion).toHaveBeenCalledWith('test-session', params.input, params.options, undefined);
      expect(result).toEqual(mockResult);
    });

    it('ExitPlanMode delegates to handleExitPlanMode', async () => {
      const mockResult: ToolDecision = { behavior: 'allow', updatedInput: { planFilePath: '/plan.md' } };
      const deps = createDeps({ handleExitPlanMode: vi.fn().mockResolvedValue(mockResult) });
      const params = createParams({ toolName: 'ExitPlanMode', input: { planFilePath: '/plan.md' } });
      const result = await resolveImmediateToolDecision(deps, params);
      expect(deps.handleExitPlanMode).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });

    it('EnterPlanMode sets mode and returns null (SDK handles natively)', async () => {
      const deps = createDeps();
      const params = createParams({ toolName: 'EnterPlanMode' });
      const result = await resolveImmediateToolDecision(deps, params);
      expect(result).toBeNull();
      expect(deps.setCurrentMode).toHaveBeenCalledWith('planning');
    });
  });

  // Regression coverage for nimbalyst#236. All 11 in-process tracker MCP
  // tools registered by the `nimbalyst-mcp` server were missing from
  // `INTERNAL_MCP_TOOLS`. Without an entry,
  // `resolveImmediateToolDecision` returned null, the SDK fell through to
  // the dialog handler which has no UI for nimbalyst-owned tools, the
  // Promise never resolved, and the SDK surfaced "user cancelled MCP tool
  // call" so the kanban board appeared broken.
  describe('tracker MCP tools are in INTERNAL_MCP_TOOLS allowlist (#236)', () => {
    // Tracker CRUD lives on the deferred `nimbalyst-trackers` server.
    const expectedTrackerTools = [
      'mcp__nimbalyst-trackers__tracker_list',
      'mcp__nimbalyst-trackers__tracker_get',
      'mcp__nimbalyst-trackers__tracker_list_types',
      'mcp__nimbalyst-trackers__tracker_create',
      'mcp__nimbalyst-trackers__tracker_update',
      'mcp__nimbalyst-trackers__tracker_link_session',
      'mcp__nimbalyst-trackers__tracker_unlink_session',
      'mcp__nimbalyst-trackers__tracker_link_file',
      'mcp__nimbalyst-trackers__tracker_add_comment',
      'mcp__nimbalyst-trackers__tracker_define_type',
      'mcp__nimbalyst-trackers__tracker_delete_type',
    ];

    for (const toolName of expectedTrackerTools) {
      it(`${toolName} is auto-allowed via the real INTERNAL_MCP_TOOLS list`, async () => {
        // Use the real production list, not the controlled stub.
        expect(INTERNAL_MCP_TOOLS).toContain(toolName);

        const deps = createDeps({ internalMcpTools: INTERNAL_MCP_TOOLS as readonly string[] as string[] });
        const params = createParams({ toolName, input: { foo: 'bar' } });
        const result = await resolveImmediateToolDecision(deps, params);
        assertZodCompliantAllow(result);
        expect(result!.updatedInput).toEqual({ foo: 'bar' });
      });
    }

    it('does NOT broaden to third-party MCP tools in non-auto modes', async () => {
      const deps = createDeps({
        internalMcpTools: INTERNAL_MCP_TOOLS as readonly string[] as string[],
        getCurrentMode: () => 'agent',
      });
      const params = createParams({
        toolName: 'mcp__some-third-party-server__do_something',
        input: { x: 1 },
      });
      const result = await resolveImmediateToolDecision(deps, params);
      expect(result).toBeNull();
    });

    it('auto-approves third-party MCP tools in auto mode', async () => {
      const deps = createDeps({ getCurrentMode: () => 'auto' });
      const params = createParams({
        toolName: 'mcp__some-third-party-server__do_something',
        input: { x: 1 },
      });
      const result = await resolveImmediateToolDecision(deps, params);
      assertZodCompliantAllow(result);
    });

    it('auto-approves Skill tool in auto mode', async () => {
      const deps = createDeps({ getCurrentMode: () => 'auto' });
      const params = createParams({ toolName: 'Skill', input: { skill: 'commit' } });
      const result = await resolveImmediateToolDecision(deps, params);
      assertZodCompliantAllow(result);
    });

    it('does NOT auto-approve Bash in auto mode even with bypass-all trust', async () => {
      // Auto mode only activates under bypass-all in production. When the
      // classifier escalates a Bash call (uncertain/risky), bypass-all must
      // NOT short-circuit — the escalation should reach the permission prompt.
      const deps = createDeps({
        getCurrentMode: () => 'auto',
        trustChecker: vi.fn().mockReturnValue({ trusted: true, mode: 'bypass-all' }),
      });
      const params = createParams({ toolName: 'Bash', input: { command: 'rm -rf /' } });
      const result = await resolveImmediateToolDecision(deps, params);
      expect(result).toBeNull();
    });

    it('still auto-allows the core internal tools (regression guard)', async () => {
      // Make sure the tracker entries did not remove or break the core internal
      // tools (now on the eager `nimbalyst` server).
      expect(INTERNAL_MCP_TOOLS).toContain('mcp__nimbalyst__update_session_meta');
      expect(INTERNAL_MCP_TOOLS).toContain('mcp__nimbalyst__display_to_user');
      expect(INTERNAL_MCP_TOOLS).toContain('mcp__nimbalyst__capture_editor_screenshot');
    });
  });

  describe('fallthrough to permission system', () => {
    it('returns null for unknown tool in ask mode', async () => {
      const deps = createDeps();
      const params = createParams({ toolName: 'Bash' });
      const result = await resolveImmediateToolDecision(deps, params);
      expect(result).toBeNull();
    });

    it('allow-all mode does NOT auto-approve non-file tools', async () => {
      const deps = createDeps({ trustChecker: vi.fn().mockReturnValue({ trusted: true, mode: 'allow-all' }) });
      const params = createParams({ toolName: 'Bash' });
      const result = await resolveImmediateToolDecision(deps, params);
      expect(result).toBeNull();
    });
  });
});
