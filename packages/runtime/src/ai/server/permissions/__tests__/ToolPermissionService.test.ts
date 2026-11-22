// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ToolPermissionService } from '../ToolPermissionService';
import { generateToolPattern, matchesAllowPattern } from '../toolPermissionHelpers';

vi.mock('../../../../storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: class {} }));

describe('SDK permission prompt constraints', () => {
  it.each(['session', 'always', 'always-all'] as const)('does not cache or persist a constrained %s response', async (scope) => {
    const emit = vi.fn();
    const patternSaver = vi.fn();
    const service = new ToolPermissionService({
      trustChecker: () => ({ trusted: true, mode: 'ask' }),
      patternSaver,
      patternChecker: async () => false,
      emit,
    });
    vi.spyOn(service as any, 'pollForPermissionResponse').mockResolvedValue(undefined);
    const hints = { defaultToNo: true, suppressAlwaysAllowRule: true };
    const pending = service.requestToolPermission({
      requestId: 'request', sessionId: 'session', workspacePath: '/fixture', permissionsPath: '/fixture',
      toolName: 'Bash', toolInput: { command: 'npm test' }, pattern: 'Bash(npm test:*)',
      patternDisplayName: 'npm test', toolDescription: 'Run tests', isDestructive: false,
      signal: new AbortController().signal, ...hints,
    });
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
    service.resolvePermission('request', { decision: 'allow', scope });
    expect(await pending).toEqual({ decision: 'allow', scope: 'once' });
    expect(patternSaver).not.toHaveBeenCalled();
    expect(service.getSessionApprovedPatterns().size).toBe(0);
    expect(emit).toHaveBeenCalledWith('toolPermission:pending', expect.objectContaining({ request: expect.objectContaining(hints) }));
  });
});

// #1740: in Agent-verified bypass-all mode, a call escalated to the user (hook "ask" or the
// classifier) must wait for an answer instead of being auto-approved under the drawn card.
describe('bypass-all with a required user decision', () => {
  function createService() {
    const service = new ToolPermissionService({
      trustChecker: () => ({ trusted: true, mode: 'bypass-all' }),
      patternSaver: vi.fn(),
      patternChecker: async () => false,
      emit: vi.fn(),
    });
    vi.spyOn(service as any, 'pollForPermissionResponse').mockResolvedValue(undefined);
    return service;
  }
  const request = (requiresUserDecision?: 'escalated') => ({
    requestId: 'request', sessionId: 'session', workspacePath: '/fixture', permissionsPath: '/fixture',
    toolName: 'Bash', toolInput: { command: 'touch /tmp/ask-probe-1' }, pattern: 'Bash(touch:*)',
    patternDisplayName: 'touch', toolDescription: 'touch', isDestructive: true,
    signal: new AbortController().signal, requiresUserDecision,
  });

  it('waits for the user and honors a deny', async () => {
    const service = createService();
    const pending = service.requestToolPermission(request('escalated'));
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
    service.resolvePermission('request', { decision: 'deny', scope: 'once' });
    expect(await pending).toEqual({ decision: 'deny', scope: 'once' });
  });

  it('still auto-approves when no user decision is required', async () => {
    const service = createService();
    expect(await service.requestToolPermission(request())).toEqual({ decision: 'allow', scope: 'once' });
    expect(service.hasPendingPermissions()).toBe(false);
  });
});

// #1741: a PreToolUse hook "ask" must reach the user every time. A Session click, a saved
// Always rule, or the allow-edits shortcut must not answer it. Ordinary requests keep them.
describe('hook ask overrides remembered approvals', () => {
  function createService(saved: string[] = []) {
    const service = new ToolPermissionService({
      trustChecker: () => ({ trusted: true, mode: 'allow-all' }),
      patternSaver: vi.fn(),
      patternChecker: async (_path, pattern) => saved.some(allow => matchesAllowPattern(pattern, allow)),
      emit: vi.fn(),
    });
    vi.spyOn(service as any, 'pollForPermissionResponse').mockResolvedValue(undefined);
    return service;
  }
  const request = (command: string, requiresUserDecision?: 'hook-ask', toolName = 'Bash') => ({
    requestId: `request-${command}`, sessionId: 'session', workspacePath: '/fixture', permissionsPath: '/fixture',
    toolName, toolInput: { command }, pattern: generateToolPattern(toolName, { command }),
    patternDisplayName: command, toolDescription: command, isDestructive: true,
    signal: new AbortController().signal, requiresUserDecision,
  });
  async function answer(service: ToolPermissionService, req: ReturnType<typeof request>, scope: 'once' | 'session' | 'always') {
    const pending = service.requestToolPermission(req);
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
    service.resolvePermission(req.requestId, { decision: 'allow', scope });
    return pending;
  }

  it('still prompts for a hook ask after a Session approval of the same pattern', async () => {
    const service = createService();
    await answer(service, request('touch /tmp/ask-probe-8', 'hook-ask'), 'session');
    const pending = service.requestToolPermission(request('touch /tmp/ask-probe-9', 'hook-ask'));
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
    service.resolvePermission('request-touch /tmp/ask-probe-9', { decision: 'deny', scope: 'once' });
    expect(await pending).toEqual({ decision: 'deny', scope: 'once' });
  });

  it('still prompts for a hook ask that a saved Always rule covers', async () => {
    const service = createService(['Bash(touch:*)']);
    service.requestToolPermission(request('touch /tmp/ask-probe-9', 'hook-ask'));
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
  });

  it('still prompts for a hook ask on a file edit under Allow edits only', async () => {
    const service = createService();
    service.requestToolPermission(request('edit', 'hook-ask', 'Edit'));
    await vi.waitFor(() => expect(service.hasPendingPermissions()).toBe(true));
  });

  it('keeps Session approvals and saved rules for ordinary requests', async () => {
    const service = createService(['Bash(gh:*)']);
    await answer(service, request('touch /tmp/a'), 'session');
    expect(await service.requestToolPermission(request('touch /tmp/b'))).toEqual({ decision: 'allow', scope: 'session' });
    expect(await service.requestToolPermission(request('gh pr merge 12'))).toEqual({ decision: 'allow', scope: 'always' });
  });
});

// #375: the model can call the same MCP tool several times at once. Each call asks its own
// question. One "Always" (or "session") answer must settle every waiting call for that tool,
// or the user is asked again for something they already allowed.
describe('one answer settles every waiting request for the same rule', () => {
  const mcpTool = 'mcp__serena__find_symbol';
  function createService(patternChecker: () => Promise<boolean> = async () => false) {
    const emit = vi.fn();
    const patternSaver = vi.fn();
    const recordReleasedPermission = vi.fn();
    const service = new ToolPermissionService({
      trustChecker: () => ({ trusted: true, mode: 'ask' }),
      patternSaver,
      patternChecker,
      emit,
      recordReleasedPermission,
    });
    vi.spyOn(service as any, 'pollForPermissionResponse').mockResolvedValue(undefined);
    return { service, emit, patternSaver, recordReleasedPermission };
  }
  type AskOverrides = Partial<Parameters<ToolPermissionService['requestToolPermission']>[0]>;
  const ask = (service: ToolPermissionService, requestId: string, toolName = mcpTool, overrides: AskOverrides = {}) =>
    service.requestToolPermission({
      requestId, sessionId: 'session', workspacePath: '/fixture', permissionsPath: '/fixture',
      toolName, toolInput: {}, pattern: toolName,
      patternDisplayName: toolName, toolDescription: toolName, isDestructive: false,
      signal: new AbortController().signal,
      ...overrides,
    });
  const waitingCount = (service: ToolPermissionService) => (service as any).pendingPermissions.size;
  // A request that is still waiting never settles, so race it against a short timer.
  const settledOrStillWaiting = (promise: Promise<unknown>) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 100))]);

  it.each(['always', 'session'] as const)('a %s answer lets the other waiting call for the same tool through', async (scope) => {
    const { service, emit, patternSaver, recordReleasedPermission } = createService();
    const first = ask(service, 'first');
    const second = ask(service, 'second');
    await vi.waitFor(() => expect(waitingCount(service)).toBe(2));

    service.resolvePermission('first', { decision: 'allow', scope });

    expect(await first).toEqual({ decision: 'allow', scope });
    // The second call gets the same answer a later call gets from the session cache.
    expect(await settledOrStillWaiting(second)).toEqual({ decision: 'allow', scope: 'session' });
    expect(waitingCount(service)).toBe(0);
    // Both prompts must be closed, and the rule must be saved once, not once per prompt.
    expect(recordReleasedPermission).toHaveBeenCalledWith('session', 'second', { decision: 'allow', scope: 'session' });
    expect(emit).toHaveBeenCalledWith('toolPermission:resolved', expect.objectContaining({ requestId: 'second' }));
    expect(patternSaver).toHaveBeenCalledTimes(scope === 'always' ? 1 : 0);
  });

  it('leaves a call for a different tool waiting', async () => {
    const { service } = createService();
    const first = ask(service, 'first');
    const other = ask(service, 'other', 'mcp__serena__replace_symbol_body');
    await vi.waitFor(() => expect(waitingCount(service)).toBe(2));

    service.resolvePermission('first', { decision: 'allow', scope: 'always' });
    await first;

    expect(await settledOrStillWaiting(other)).toBe('still waiting');
    expect(waitingCount(service)).toBe(1);
  });

  it.each([{ decision: 'allow', scope: 'once' }, { decision: 'deny', scope: 'always' }] as const)(
    'leaves the other waiting call alone after a %o answer', async (answer) => {
      const { service } = createService();
      const first = ask(service, 'first');
      const second = ask(service, 'second');
      await vi.waitFor(() => expect(waitingCount(service)).toBe(2));

      service.resolvePermission('first', answer);
      await first;

      expect(await settledOrStillWaiting(second)).toBe('still waiting');
      expect(waitingCount(service)).toBe(1);
    });

  it('tells the caller once about the released call, with its id and the allow answer', async () => {
    const { service, recordReleasedPermission } = createService();
    const first = ask(service, 'first');
    const second = ask(service, 'second');
    await vi.waitFor(() => expect(waitingCount(service)).toBe(2));

    service.resolvePermission('first', { decision: 'allow', scope: 'always' });
    await first;
    await second;

    expect(recordReleasedPermission).toHaveBeenCalledTimes(1);
    expect(recordReleasedPermission).toHaveBeenCalledWith('session', 'second', { decision: 'allow', scope: 'session' });
  });

  it('leaves a waiting call in another session alone', async () => {
    const { service, recordReleasedPermission } = createService();
    const inSessionA = ask(service, 'a', mcpTool, { sessionId: 'session-a' });
    const inSessionB = ask(service, 'b', mcpTool, { sessionId: 'session-b' });
    await vi.waitFor(() => expect(waitingCount(service)).toBe(2));

    service.resolvePermission('a', { decision: 'allow', scope: 'always' });
    await inSessionA;

    expect(await settledOrStillWaiting(inSessionB)).toBe('still waiting');
    expect(waitingCount(service)).toBe(1);
    expect(recordReleasedPermission).not.toHaveBeenCalled();
  });

  it('leaves a waiting call alone when it asked to be approved one time only', async () => {
    const { service, recordReleasedPermission } = createService();
    const first = ask(service, 'first');
    const oneTimeOnly = ask(service, 'one-time-only', mcpTool, { suppressAlwaysAllowRule: true });
    await vi.waitFor(() => expect(waitingCount(service)).toBe(2));

    service.resolvePermission('first', { decision: 'allow', scope: 'always' });
    await first;

    expect(await settledOrStillWaiting(oneTimeOnly)).toBe('still waiting');
    expect(waitingCount(service)).toBe(1);
    expect(recordReleasedPermission).not.toHaveBeenCalled();
  });

  it('keeps a hook-requested prompt waiting when another call approves its rule', async () => {
    const { service, recordReleasedPermission } = createService();
    const first = ask(service, 'first');
    const hookAsked = ask(service, 'hook', mcpTool, { requiresUserDecision: 'hook-ask' });
    await vi.waitFor(() => expect(waitingCount(service)).toBe(2));
    service.resolvePermission('first', { decision: 'allow', scope: 'always' });
    await first;
    expect(waitingCount(service)).toBe(1);
    expect(recordReleasedPermission).not.toHaveBeenCalled();
    service.resolvePermission('hook', { decision: 'deny', scope: 'once' });
    expect(await hookAsked).toEqual({ decision: 'deny', scope: 'once' });
  });

  it('lets "allow all WebFetches" through a waiting WebFetch call for a different address', async () => {
    const { service, patternSaver, recordReleasedPermission } = createService();
    const first = ask(service, 'first', 'WebFetch', { pattern: 'WebFetch(domain:example.com)' });
    const second = ask(service, 'second', 'WebFetch', { pattern: 'WebFetch(domain:other.org)' });
    await vi.waitFor(() => expect(waitingCount(service)).toBe(2));

    service.resolvePermission('first', { decision: 'allow', scope: 'always-all' });

    expect(await first).toEqual({ decision: 'allow', scope: 'always-all' });
    expect(await settledOrStillWaiting(second)).toEqual({ decision: 'allow', scope: 'session' });
    expect(recordReleasedPermission).toHaveBeenCalledWith('session', 'second', { decision: 'allow', scope: 'session' });
    // The wildcard is saved once for the answered call, not again for the released one.
    expect(patternSaver).toHaveBeenCalledTimes(1);
    expect(patternSaver).toHaveBeenCalledWith('/fixture', 'WebFetch');
  });

  it('does not let a compound shell command release another waiting call', async () => {
    // Compound commands get a one-of-a-kind pattern and must be approved every time, so an
    // "Always" answer on one is not saved or cached and settles nothing else. The two calls
    // here share a pattern on purpose, to show that sharing alone does not release them.
    const { service, patternSaver, recordReleasedPermission } = createService();
    const compound = { pattern: 'Bash:compound:123' };
    const first = ask(service, 'first', 'Bash', compound);
    const second = ask(service, 'second', 'Bash', compound);
    await vi.waitFor(() => expect(waitingCount(service)).toBe(2));

    service.resolvePermission('first', { decision: 'allow', scope: 'always' });
    await first;

    expect(await settledOrStillWaiting(second)).toBe('still waiting');
    expect(waitingCount(service)).toBe(1);
    expect(recordReleasedPermission).not.toHaveBeenCalled();
    expect(patternSaver).not.toHaveBeenCalled();
    expect(service.getSessionApprovedPatterns().size).toBe(0);
  });

  it('skips the question for a call that was still reading saved settings when another was answered', async () => {
    // The second call is held inside the saved-settings lookup. While it is held, the first
    // call is answered "session". The second call must see that answer, not wait for a prompt.
    let releaseSettingsLookup: (approved: boolean) => void = () => {};
    const patternChecker = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { releaseSettingsLookup = resolve; }));
    const { service, emit } = createService(patternChecker);

    const first = ask(service, 'first');
    await vi.waitFor(() => expect(waitingCount(service)).toBe(1));
    const second = ask(service, 'second');
    await vi.waitFor(() => expect(patternChecker).toHaveBeenCalledTimes(2));

    service.resolvePermission('first', { decision: 'allow', scope: 'session' });
    await first;
    releaseSettingsLookup(false);

    expect(await settledOrStillWaiting(second)).toEqual({ decision: 'allow', scope: 'session' });
    expect(waitingCount(service)).toBe(0);
    expect(emit).not.toHaveBeenCalledWith('toolPermission:pending', expect.objectContaining({ requestId: 'second' }));
  });
});
