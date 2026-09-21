// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { ToolPermissionService } from '../ToolPermissionService';

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
