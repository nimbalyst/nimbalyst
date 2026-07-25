import { describe, expect, it } from 'vitest';
import { expandSessionMentions } from '../sessionMentions';

describe('expandSessionMentions', () => {
  it('expands compact session ids and leaves unknown mentions alone', () => {
    const registry = new Map([
      ['12345abc-def0-1234-5678-123456789abc', { title: 'Source session' } as any],
    ]);
    expect(expandSessionMentions(
      'Compare @@[Source session](12345) with @@[Unknown](fffff)',
      registry,
    )).toBe(
      'Compare @@[Source session](12345abc-def0-1234-5678-123456789abc) with @@[Unknown](fffff)',
    );
  });
});
