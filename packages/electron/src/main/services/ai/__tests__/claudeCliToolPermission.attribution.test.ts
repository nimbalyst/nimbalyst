import { describe, it, expect, vi } from 'vitest';
import {
  buildToolPermissionBehaviorResult,
  buildToolPermissionResultPayload,
  normalizeToolPermissionAnswer,
  resolveClaudeCliToolPermission,
  toToolPermissionMcpResult,
  type ToolPermissionAnswer,
  type ToolPermissionDeps,
  type ToolPermissionUnansweredReason,
} from '../claudeCliToolPermission';

/**
 * #1348: three fail-closed paths settled as `cancelled: true`, which is also
 * what a real user cancellation sets, so the CLI was told "Tool call cancelled
 * by user" for prompts no user was ever shown. The deny is right. Who it is
 * attributed to was not.
 */

const input = { file_path: '/w/a.ts', content: 'x' };
const REASONS: ToolPermissionUnansweredReason[] = ['client-abort', 'timeout', 'wait-failed'];

function messageFor(answer: ToolPermissionAnswer): string {
  const r = buildToolPermissionBehaviorResult(answer, input);
  expect(r.behavior).toBe('deny');
  return (r as { behavior: 'deny'; message: string }).message;
}

describe('unanswered denies are not attributed to the user (#1348)', () => {
  it.each(REASONS)('%s says no user decision was made', reason => {
    const message = messageFor({ decision: 'deny', scope: 'once', cancelled: true, unansweredReason: reason });
    expect(message).toContain('No user decision was made');
    expect(message).toContain('not answered');
  });

  it.each(REASONS)('%s never claims the user cancelled or denied', reason => {
    const message = messageFor({ decision: 'deny', scope: 'once', cancelled: true, unansweredReason: reason });
    expect(message).not.toContain('by user');
  });

  it('gives each reason its own message, so the cause is diagnosable', () => {
    const messages = REASONS.map(reason =>
      messageFor({ decision: 'deny', scope: 'once', cancelled: true, unansweredReason: reason }),
    );
    expect(new Set(messages).size).toBe(REASONS.length);
    expect(messages[0]).toContain('session ended');
    expect(messages[1]).toContain('timed out');
    expect(messages[2]).toContain('could not be delivered');
  });
});

/**
 * The controls that must go the other way. A change that simply reworded every
 * deny would satisfy the block above while destroying the real distinction, so
 * a genuine user decision has to keep saying so.
 */
describe('a real user decision is still attributed to the user', () => {
  it('a user deny still reads as denied by user', () => {
    expect(messageFor({ decision: 'deny', scope: 'once' })).toBe('Tool call denied by user');
  });

  it('a user cancellation still reads as cancelled by user', () => {
    expect(messageFor({ decision: 'deny', scope: 'once', cancelled: true })).toBe(
      'Tool call cancelled by user',
    );
  });

  it('a cancelled allow is still a deny attributed to the user', () => {
    expect(messageFor({ decision: 'allow', scope: 'once', cancelled: true })).toBe(
      'Tool call cancelled by user',
    );
  });

  it('an allow is unaffected', () => {
    expect(buildToolPermissionBehaviorResult({ decision: 'allow', scope: 'once' }, input)).toEqual({
      behavior: 'allow',
      updatedInput: input,
    });
  });

  it('an unanswered reason cannot turn an allow into a deny on its own', () => {
    // Defensive: the field describes attribution, not the decision. An allow
    // that somehow carries one must still allow, or a stray field could start
    // blocking approved calls.
    expect(
      buildToolPermissionBehaviorResult(
        { decision: 'allow', scope: 'once', unansweredReason: 'timeout' },
        input,
      ),
    ).toEqual({ behavior: 'allow', updatedInput: input });
  });
});

describe('a surface cannot forge an unanswered reason', () => {
  it.each(REASONS)('drops %s arriving in an IPC payload', reason => {
    // "Unanswered" means nobody answered. An answer that arrived cannot be one,
    // and a renderer must not be able to dress its own decision as an
    // infrastructure failure.
    const answer = normalizeToolPermissionAnswer({ decision: 'deny', scope: 'once', unansweredReason: reason });
    expect(answer.unansweredReason).toBeUndefined();
    expect(messageFor(answer)).toBe('Tool call denied by user');
  });

  it('drops it from a nested response payload too', () => {
    const answer = normalizeToolPermissionAnswer({
      response: { decision: 'deny', scope: 'once', cancelled: true, unansweredReason: 'timeout' },
    });
    expect(answer.unansweredReason).toBeUndefined();
    expect(messageFor(answer)).toBe('Tool call cancelled by user');
  });

  // The control: normalize is not simply discarding everything it is handed.
  it('still carries the fields a surface is allowed to set', () => {
    expect(normalizeToolPermissionAnswer({ decision: 'allow', scope: 'always', cancelled: false })).toEqual({
      decision: 'allow',
      scope: 'always',
      cancelled: false,
    });
  });
});

describe('the persisted widget payload records the distinction', () => {
  it('carries the reason when there was no answer', () => {
    expect(
      buildToolPermissionResultPayload({
        decision: 'deny',
        scope: 'once',
        cancelled: true,
        unansweredReason: 'client-abort',
      }),
    ).toEqual({ decision: 'deny', scope: 'once', cancelled: true, unansweredReason: 'client-abort' });
  });

  it('omits the key entirely for a real user answer', () => {
    const payload = buildToolPermissionResultPayload({ decision: 'deny', scope: 'once', cancelled: true });
    expect(payload).toEqual({ decision: 'deny', scope: 'once', cancelled: true });
    expect('unansweredReason' in payload).toBe(false);
  });
});

/**
 * The pure tests above prove the message is right for a given reason. This one
 * proves the reason is actually attached where it happens, which no assertion
 * on the helpers can show.
 */
describe('a failed wait reaches the CLI as unanswered, end to end (#1348)', () => {
  function makeDeps(overrides: Partial<ToolPermissionDeps> = {}): ToolPermissionDeps {
    return {
      isPatternApproved: vi.fn(() => false),
      markPatternApproved: vi.fn(),
      persistToolUse: vi.fn(async () => {}),
      persistToolResult: vi.fn(async () => {}),
      setWaitingStatus: vi.fn(),
      applySettle: vi.fn(),
      savePattern: vi.fn(async () => {}),
      notifyBlocked: vi.fn(),
      makeRequestId: vi.fn(() => 'req-attribution'),
      waitForAnswer: async () => ({ decision: 'allow', scope: 'once' }) as ToolPermissionAnswer,
      ...overrides,
    } as ToolPermissionDeps;
  }

  async function resolveWith(deps: ToolPermissionDeps) {
    const result = await resolveClaudeCliToolPermission(
      { args: { tool_name: 'Read', input: { file_path: '/w/a.ts' } }, sessionId: 's1', workspacePath: '/w' },
      deps,
    );
    return JSON.parse(result.content[0].text) as { behavior: string; message?: string };
  }

  it('does not tell the CLI the user cancelled when the wait rejected', async () => {
    const behavior = await resolveWith(
      makeDeps({
        waitForAnswer: async () => {
          throw new Error('socket closed');
        },
      }),
    );
    expect(behavior.behavior).toBe('deny');
    expect(behavior.message).toContain('No user decision was made');
    expect(behavior.message).not.toContain('by user');
  });

  it('records the unanswered state on the persisted widget result', async () => {
    const persistToolResult = vi.fn<ToolPermissionDeps['persistToolResult']>(async () => {});
    await resolveWith(
      makeDeps({
        persistToolResult,
        waitForAnswer: async () => {
          throw new Error('socket closed');
        },
      }),
    );
    expect(persistToolResult).toHaveBeenCalledTimes(1);
    expect(persistToolResult.mock.calls[0][0]).toMatchObject({
      result: { decision: 'deny', cancelled: true, unansweredReason: 'wait-failed' },
      isError: true,
    });
  });

  // The control that must go the other way: a wait that RESOLVES with a real
  // user deny must still be attributed to the user, or this change would have
  // erased the distinction it exists to draw.
  it('still attributes a real user deny to the user', async () => {
    const behavior = await resolveWith(
      makeDeps({ waitForAnswer: async () => ({ decision: 'deny', scope: 'once' }) }),
    );
    expect(behavior.message).toBe('Tool call denied by user');
  });

  it('still allows when the user allows', async () => {
    const behavior = await resolveWith(makeDeps());
    expect(behavior.behavior).toBe('allow');
  });
});

describe('the CLI return contract is unchanged in shape', () => {
  it.each(REASONS)('%s is still a normal deny response, not a tool error', reason => {
    const behavior = buildToolPermissionBehaviorResult(
      { decision: 'deny', scope: 'once', cancelled: true, unansweredReason: reason },
      input,
    );
    const mcp = toToolPermissionMcpResult(behavior);
    expect(mcp.isError).toBe(false);
    expect(JSON.parse(mcp.content[0].text)).toEqual(behavior);
  });
});
