import { describe, expect, it } from 'vitest';
import { preserveEquivalentSetRef } from '../atoms/sessionFiles';

describe('preserveEquivalentSetRef', () => {
  it('reuses the current Set when pending review files are unchanged', () => {
    const current = new Set(['/tmp/a.ts', '/tmp/b.ts']);
    const next = new Set(['/tmp/a.ts', '/tmp/b.ts']);

    const merged = preserveEquivalentSetRef(current, next);

    expect(merged).toBe(current);
  });

  it('keeps the new Set when pending review files changed', () => {
    const current = new Set(['/tmp/a.ts']);
    const next = new Set(['/tmp/a.ts', '/tmp/b.ts']);

    const merged = preserveEquivalentSetRef(current, next);

    expect(merged).toBe(next);
  });

  it('treats identical members as equal regardless of insertion order', () => {
    const current = new Set(['/tmp/a.ts', '/tmp/b.ts']);
    const next = new Set(['/tmp/b.ts', '/tmp/a.ts']);

    const merged = preserveEquivalentSetRef(current, next);

    expect(merged).toBe(current);
  });
});
