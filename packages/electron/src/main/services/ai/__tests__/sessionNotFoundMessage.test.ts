// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sessionNotFoundMessage } from '../sessionNotFoundMessage';

describe('sessionNotFoundMessage (GitHub #1887)', () => {
  it('names the owning workspace when the session exists in a different one', () => {
    expect(sessionNotFoundMessage('s1', '/b', { workspacePath: '/a' }))
      .toBe('Session s1 belongs to the workspace /a, not /b. Open /a to continue it.');
  });

  it('keeps the plain message for a missing or same-workspace session', () => {
    expect(sessionNotFoundMessage('s1', '/b', null)).toBe('Session s1 not found');
    expect(sessionNotFoundMessage('s1', '/b', { workspacePath: '/b' })).toBe('Session s1 not found');
  });
});
