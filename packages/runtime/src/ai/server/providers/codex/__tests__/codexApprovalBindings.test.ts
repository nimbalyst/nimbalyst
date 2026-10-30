// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createCodexApprovalBindings, type CodexApprovalTurn } from '../codexApprovalBindings';
import type { ToolPermissionService } from '../../../permissions/ToolPermissionService';
import type { ItemCommandExecutionRequestApprovalParams, ItemFileChangeRequestApprovalParams } from '../../../protocols/codexAppServer/types';
import approvalCaptures from '../../../protocols/__tests__/fixtures/codexAppServerApprovals.captured.json';

// #1884. The captured `rm -rf` request offers accept, acceptWithExecpolicyAmendment and cancel.
const rmRequest = approvalCaptures['write-onrequest-rm'].find((e) => e.kind === 'serverRequest')!
  .params as unknown as ItemCommandExecutionRequestApprovalParams;
const editRequest = approvalCaptures['readonly-edit'].find((e) => e.kind === 'serverRequest')!
  .params as unknown as ItemFileChangeRequestApprovalParams;
const context = { nimbalystSessionId: 'nim-1', workspacePath: '/tmp/ws' };

function setup(options: { turn?: Partial<CodexApprovalTurn> | null; answer?: unknown; reject?: Error } = {}) {
  const controller = new AbortController();
  const turn: CodexApprovalTurn | undefined = options.turn === null ? undefined : {
    workspacePath: '/tmp/ws',
    permissionsPath: '/tmp/ws',
    signal: controller.signal,
    agentVerified: false,
    ...options.turn,
  };
  const requestToolPermission = vi.fn(async (_request: { requestId: string }): Promise<unknown> => {
    if (options.reject) throw options.reject;
    return options.answer ?? { decision: 'allow', scope: 'once' };
  });
  const logAgentMessage = vi.fn(async () => {});
  const { bindings, onPermissionPrompt } = createCodexApprovalBindings({
    permissionService: () => ({ requestToolPermission }) as unknown as ToolPermissionService,
    turnFor: (id) => (id === 'nim-1' ? turn : undefined),
    logAgentMessage,
  });
  return { bindings, onPermissionPrompt, requestToolPermission, logAgentMessage, controller };
}

describe('Codex approval bindings', () => {
  it('asks about the inner command and answers Always with the proposed exec-policy amendment', async () => {
    const { bindings, requestToolPermission } = setup({ answer: { decision: 'allow', scope: 'always' } });

    const reply = await bindings.approveCommandExecution!(rmRequest, context);

    expect(requestToolPermission).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'nim-1',
      toolName: 'Bash',
      toolInput: expect.objectContaining({ command: 'rm -rf /tmp/codex-capture/outside/old-build' }),
      pattern: 'Bash(rm:*)',
    }));
    expect(reply).toEqual({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: rmRequest.proposedExecpolicyAmendment } } });
  });

  it('never offers to remember a command Codex left wrapped in a shell', async () => {
    const { bindings, requestToolPermission } = setup();
    await bindings.approveCommandExecution!({
      ...rmRequest,
      command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -Command "Remove-Item -Recurse old-build; Remove-Item -Recurse dist"',
      commandActions: [{ type: 'unknown', command: 'Remove-Item -Recurse old-build' }, { type: 'unknown', command: 'Remove-Item -Recurse dist' }],
    }, context);
    expect(requestToolPermission).toHaveBeenCalledWith(expect.objectContaining({
      pattern: `Bash:compound:${rmRequest.itemId}`,
      suppressAlwaysAllowRule: true,
    }));
  });

  it('only sends decisions Codex offered, and declines a denial', async () => {
    // acceptForSession is not in the captured availableDecisions.
    expect(await setup({ answer: { decision: 'allow', scope: 'session' } }).bindings.approveCommandExecution!(rmRequest, context))
      .toEqual({ decision: 'accept' });
    expect(await setup({ answer: { decision: 'deny', scope: 'once' } }).bindings.approveCommandExecution!(rmRequest, context))
      .toEqual({ decision: 'decline' });
  });

  it('cancels when the turn is aborted and refuses outside a turn or on a service error', async () => {
    const aborted = setup({ reject: new Error('Request aborted') });
    aborted.controller.abort();
    expect(await aborted.bindings.approveCommandExecution!(rmRequest, context)).toEqual({ decision: 'cancel' });

    const noTurn = setup({ turn: null });
    expect(await noTurn.bindings.approveCommandExecution!(rmRequest, context)).toEqual({ decision: 'decline' });
    expect(noTurn.requestToolPermission).not.toHaveBeenCalled();

    const untrusted = setup({ reject: new Error('Workspace is not trusted.') });
    expect(await untrusted.bindings.approveCommandExecution!(rmRequest, context)).toEqual({ decision: 'decline' });
  });

  it('makes the user answer in Agent-verified mode instead of the bypass-all shortcut', async () => {
    const { bindings, requestToolPermission } = setup({ turn: { agentVerified: true } });
    await bindings.approveCommandExecution!(rmRequest, context);
    expect(requestToolPermission).toHaveBeenCalledWith(expect.objectContaining({ requiresUserDecision: 'escalated' }));
  });

  it('logs the transcript card only when the service actually prompts', async () => {
    const { bindings, onPermissionPrompt, requestToolPermission, logAgentMessage } = setup();
    requestToolPermission.mockImplementationOnce(async (request: { requestId: string }) => {
      onPermissionPrompt({ requestId: request.requestId });
      return { decision: 'allow', scope: 'once' };
    });

    await bindings.approveCommandExecution!(rmRequest, context);
    expect(logAgentMessage).toHaveBeenCalledTimes(1);
    const [sessionId, content] = logAgentMessage.mock.calls[0] as unknown as [string, string];
    expect(sessionId).toBe('nim-1');
    expect(JSON.parse(content)).toMatchObject({ type: 'nimbalyst_tool_use', name: 'ToolPermission', input: { toolName: 'Bash' } });

    // Auto-approved (no prompt event): no card.
    await bindings.approveCommandExecution!(rmRequest, context);
    expect(logAgentMessage).toHaveBeenCalledTimes(1);
  });

  it('asks about file edits with the paths from the fileChange item', async () => {
    const { bindings, requestToolPermission } = setup({ answer: { decision: 'allow', scope: 'session' } });
    const reply = await bindings.approveFileChange!(editRequest, {
      ...context,
      fileChanges: [{ path: '/tmp/ws/hello.txt', kind: { type: 'add' }, diff: 'hi\n' }],
    });
    expect(requestToolPermission).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'Edit',
      toolInput: expect.objectContaining({ file_path: '/tmp/ws/hello.txt' }),
    }));
    expect(reply).toEqual({ decision: 'acceptForSession' });
  });

  it('grants exactly the requested sandbox permissions, or nothing', async () => {
    const params = { threadId: 't', turnId: 'u', itemId: 'p', reason: 'fetch deps', permissions: { network: { enabled: true }, fileSystem: null } };
    expect(await setup().bindings.approvePermissions!(params, context))
      .toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
    expect(await setup({ answer: { decision: 'deny', scope: 'once' } }).bindings.approvePermissions!(params, context))
      .toEqual({ permissions: {}, scope: 'turn' });
  });
});
