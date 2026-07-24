/**
 * Tests for `resolvePermissionMode`.
 *
 * Maps the Nimbalyst session mode (planning | agent | auto | undefined)
 * to the Claude Agent SDK's `permissionMode` parameter.
 */

import { describe, it, expect } from 'vitest';
import { resolvePermissionMode } from '../sdkOptionsBuilder';

describe('resolvePermissionMode', () => {
  it('maps planning to plan', () => {
    expect(resolvePermissionMode('planning')).toBe('plan');
  });

  it('maps auto to auto (SDK classifier, distinct from acceptEdits)', () => {
    expect(resolvePermissionMode('auto')).toBe('auto');
  });

  it('maps agent to default', () => {
    expect(resolvePermissionMode('agent')).toBe('default');
  });

  it('maps undefined to default (safety fallback for legacy sessions)', () => {
    expect(resolvePermissionMode(undefined)).toBe('default');
  });
});
