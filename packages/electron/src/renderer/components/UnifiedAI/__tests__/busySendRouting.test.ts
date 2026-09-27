// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveBusySendAction } from '../busySendRouting';

describe('resolveBusySendAction', () => {
  it('steers only when the provider takes mid-turn input and the draft is text-only', () => {
    expect(resolveBusySendAction('steer', { midTurnInput: true, hasAttachments: false })).toBe('steer');
    expect(resolveBusySendAction('steer', { midTurnInput: false, hasAttachments: false })).toBe('interrupt');
    expect(resolveBusySendAction('steer', { midTurnInput: true, hasAttachments: true })).toBe('interrupt');
  });

  it('leaves queue and interrupt alone', () => {
    expect(resolveBusySendAction('queue', { midTurnInput: true, hasAttachments: false })).toBe('queue');
    expect(resolveBusySendAction('interrupt', { midTurnInput: false, hasAttachments: true })).toBe('interrupt');
  });
});
