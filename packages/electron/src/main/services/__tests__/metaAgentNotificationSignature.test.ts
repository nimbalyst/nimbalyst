import { describe, expect, it } from 'vitest';
import {
  computeNotificationSignature,
  type NotificationEventType,
  type NotificationSignatureInput,
} from '../metaAgentNotificationSignature';

function input(overrides: Partial<NotificationSignatureInput> = {}): NotificationSignatureInput {
  return {
    status: 'idle',
    pendingPrompt: null,
    lastResponse: null,
    errorMessage: null,
    ...overrides,
  };
}

describe('computeNotificationSignature', () => {
  it('produces identical signatures when every component matches', () => {
    const a = computeNotificationSignature('session:completed', input({ lastResponse: 'done' }));
    const b = computeNotificationSignature('session:completed', input({ lastResponse: 'done' }));

    expect(a).toBe(b);
  });

  it('discriminates by event type', () => {
    const completed = computeNotificationSignature('session:completed', input());
    const errored = computeNotificationSignature('session:error', input());
    const waiting = computeNotificationSignature('session:waiting', input());
    const interrupted = computeNotificationSignature('session:interrupted', input());

    const signatures = new Set([completed, errored, waiting, interrupted]);
    expect(signatures.size).toBe(4);
  });

  it('discriminates by status', () => {
    const idle = computeNotificationSignature('session:completed', input({ status: 'idle' }));
    const error = computeNotificationSignature('session:completed', input({ status: 'error' }));

    expect(idle).not.toBe(error);
  });

  it('discriminates by pending interactive prompt id', () => {
    const noPrompt = computeNotificationSignature(
      'session:waiting',
      input({ pendingPrompt: null }),
    );
    const promptA = computeNotificationSignature(
      'session:waiting',
      input({ pendingPrompt: { promptId: 'prompt-a' } }),
    );
    const promptB = computeNotificationSignature(
      'session:waiting',
      input({ pendingPrompt: { promptId: 'prompt-b' } }),
    );

    expect(noPrompt).not.toBe(promptA);
    expect(promptA).not.toBe(promptB);
  });

  it('discriminates by lastResponse text', () => {
    const oneShot = computeNotificationSignature('session:completed', input({ lastResponse: 'hello' }));
    const otherShot = computeNotificationSignature('session:completed', input({ lastResponse: 'goodbye' }));

    expect(oneShot).not.toBe(otherShot);
  });

  it('discriminates by errorMessage even when lastResponse matches', () => {
    // Regression guard for the dedup signature ignoring errorMessage. Two
    // distinct errors on the same child whose surrounding lastResponse text
    // happens to match must not be silenced.
    const errorA = computeNotificationSignature(
      'session:error',
      input({ status: 'error', lastResponse: 'partial output', errorMessage: 'ENOENT: missing file' }),
    );
    const errorB = computeNotificationSignature(
      'session:error',
      input({ status: 'error', lastResponse: 'partial output', errorMessage: 'EACCES: permission denied' }),
    );

    expect(errorA).not.toBe(errorB);
  });

  it('treats null and missing optional fields the same way', () => {
    const explicitNulls = computeNotificationSignature('session:completed', input({
      pendingPrompt: null,
      lastResponse: null,
      errorMessage: null,
    }));
    const undefinedFields = computeNotificationSignature('session:completed', {
      status: 'idle',
      pendingPrompt: undefined,
      lastResponse: undefined,
      errorMessage: undefined,
    });

    expect(explicitNulls).toBe(undefinedFields);
  });

  it('includes every discriminating field in the resulting key', () => {
    // Belt-and-suspenders: if a future refactor drops a field from the join
    // by accident, this assertion catches it without depending on the exact
    // delimiter or field order.
    const eventType: NotificationEventType = 'session:error';
    const result = input({
      status: 'error',
      pendingPrompt: { promptId: 'pp-123' },
      lastResponse: 'last text',
      errorMessage: 'boom',
    });

    const signature = computeNotificationSignature(eventType, result);

    expect(signature).toContain(eventType);
    expect(signature).toContain('error');
    expect(signature).toContain('pp-123');
    expect(signature).toContain('last text');
    expect(signature).toContain('boom');
  });
});
