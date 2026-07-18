import { describe, expect, it, vi } from 'vitest';
import { requestAttentionSupervisorAuthorization } from '../../../services/attentionSupervisorAuthorization';

describe('attention supervisor renderer reachability', () => {
  it.each([
    [true, 'supervisor-grant'],
    [false, 'supervisor-revoke'],
  ])('invokes the dedicated main route for authorize=%s', async (authorized, supervisorSessionId) => {
    const invoke = vi.fn(async () => ({ success: true, changed: true }));
    const result = await requestAttentionSupervisorAuthorization({
      workspacePath: '/workspace',
      targetSessionId: 'target-session',
      targetTitle: 'Blocked target',
      authorized,
    }, {
      promptForSupervisorId: vi.fn(() => `  ${supervisorSessionId}  `),
      invoke,
    });

    expect(result).toMatchObject({ success: true });
    expect(invoke).toHaveBeenCalledWith(
      'sessions:set-attention-supervisor-authorization',
      {
        workspacePath: '/workspace',
        targetSessionId: 'target-session',
        supervisorSessionId,
        authorized,
      },
    );
  });

  it('does not invoke main when the exact supervisor selection is cancelled', async () => {
    const invoke = vi.fn();
    await expect(requestAttentionSupervisorAuthorization({
      workspacePath: '/workspace',
      targetSessionId: 'target-session',
      targetTitle: 'Blocked target',
      authorized: true,
    }, {
      promptForSupervisorId: () => null,
      invoke,
    })).resolves.toEqual({ cancelled: true });
    expect(invoke).not.toHaveBeenCalled();
  });
});
