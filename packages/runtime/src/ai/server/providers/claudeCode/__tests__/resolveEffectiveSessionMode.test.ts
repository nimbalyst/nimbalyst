/**
 * Tests for `resolveEffectiveSessionMode`.
 *
 * Guards issue #628: "Allow All" (bypass-all) must NOT silently upgrade an
 * agent session to the auto-mode classifier unless the user opted in.
 */

import { describe, it, expect } from 'vitest';
import { resolveEffectiveSessionMode } from '../resolveEffectiveSessionMode';

describe('resolveEffectiveSessionMode', () => {
  it('keeps agent in Allow All by default (literal allow-all, no classifier) — issue #628', () => {
    expect(
      resolveEffectiveSessionMode('agent', { trusted: true, mode: 'bypass-all' }),
    ).toBe('agent');
  });

  it('upgrades agent to auto in Allow All only when the classifier is opted in', () => {
    expect(
      resolveEffectiveSessionMode('agent', {
        trusted: true,
        mode: 'bypass-all',
        allowAllUsesClassifier: true,
      }),
    ).toBe('auto');
  });

  it('does not upgrade in allow-all (edits-only) mode even with the flag set', () => {
    expect(
      resolveEffectiveSessionMode('agent', {
        trusted: true,
        mode: 'allow-all',
        allowAllUsesClassifier: true,
      }),
    ).toBe('agent');
  });

  it('does not upgrade in ask mode', () => {
    expect(
      resolveEffectiveSessionMode('agent', { trusted: true, mode: 'ask' }),
    ).toBe('agent');
  });

  it('does not upgrade an untrusted workspace', () => {
    expect(
      resolveEffectiveSessionMode('agent', {
        trusted: false,
        mode: 'bypass-all',
        allowAllUsesClassifier: true,
      }),
    ).toBe('agent');
  });

  it('leaves an explicitly-requested auto session unchanged', () => {
    expect(
      resolveEffectiveSessionMode('auto', { trusted: true, mode: 'bypass-all' }),
    ).toBe('auto');
  });

  it('leaves planning untouched', () => {
    expect(
      resolveEffectiveSessionMode('planning', {
        trusted: true,
        mode: 'bypass-all',
        allowAllUsesClassifier: true,
      }),
    ).toBe('planning');
  });

  it('handles a null trust status (no upgrade)', () => {
    expect(resolveEffectiveSessionMode('agent', null)).toBe('agent');
  });
});
