import { describe, it, expect } from 'vitest';
import { toDbBoolean } from '../trackerDbValue';

describe('toDbBoolean (NIM-864)', () => {
  it('coerces a numeric 0/1 (synced payload shape) to a strict boolean', () => {
    // PGLite rejects a number bound to a BOOLEAN column; SQLite tolerated it,
    // which is why item sync bootstrap only failed on PGLite clients.
    expect(toDbBoolean(0)).toBe(false);
    expect(toDbBoolean(1)).toBe(true);
  });

  it('passes real booleans through', () => {
    expect(toDbBoolean(true)).toBe(true);
    expect(toDbBoolean(false)).toBe(false);
  });

  it('treats null/undefined as false', () => {
    expect(toDbBoolean(null)).toBe(false);
    expect(toDbBoolean(undefined)).toBe(false);
  });

  it('always returns a primitive boolean (never a number)', () => {
    expect(typeof toDbBoolean(1)).toBe('boolean');
    expect(typeof toDbBoolean(0)).toBe('boolean');
  });
});
