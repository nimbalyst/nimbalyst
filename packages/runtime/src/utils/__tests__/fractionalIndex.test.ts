import { describe, it, expect } from 'vitest';
import { generateKeyBetween, generateNKeysBetween } from '../fractionalIndex';

describe('fractionalIndex', () => {
  describe('generateKeyBetween', () => {
    it('generates an initial key from null, null', () => {
      const key = generateKeyBetween(null, null);
      expect(key).toBeTruthy();
      expect(typeof key).toBe('string');
    });

    it('generates a key before an existing key', () => {
      const first = generateKeyBetween(null, null);
      const before = generateKeyBetween(null, first);
      expect(before < first).toBe(true);
    });

    it('generates a key after an existing key', () => {
      const first = generateKeyBetween(null, null);
      const after = generateKeyBetween(first, null);
      expect(after > first).toBe(true);
    });

    it('generates a key between two existing keys', () => {
      const a = generateKeyBetween(null, null);
      const b = generateKeyBetween(a, null);
      const mid = generateKeyBetween(a, b);
      expect(mid > a).toBe(true);
      expect(mid < b).toBe(true);
    });

    it('handles many consecutive insertions at the end', () => {
      const keys: string[] = [];
      let last: string | null = null;
      for (let i = 0; i < 100; i++) {
        const key = generateKeyBetween(last, null);
        keys.push(key);
        last = key;
      }
      // All keys should be in sorted order
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i] > keys[i - 1]).toBe(true);
      }
    });

    it('handles many consecutive insertions at the beginning', () => {
      const keys: string[] = [];
      let first: string | null = null;
      for (let i = 0; i < 100; i++) {
        const key = generateKeyBetween(null, first);
        keys.unshift(key);
        first = key;
      }
      // All keys should be in sorted order
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i] > keys[i - 1]).toBe(true);
      }
    });

    it('handles repeated midpoint insertions', () => {
      let a = generateKeyBetween(null, null);
      let b = generateKeyBetween(a, null);
      const keys = [a, b];
      for (let i = 0; i < 20; i++) {
        const mid = generateKeyBetween(a, b);
        expect(mid > a).toBe(true);
        expect(mid < b).toBe(true);
        keys.push(mid);
        // Narrow the range
        a = mid;
      }
    });
  });

  describe('generateNKeysBetween', () => {
    it('returns empty array for n=0', () => {
      expect(generateNKeysBetween(null, null, 0)).toEqual([]);
    });

    it('returns one key for n=1', () => {
      const keys = generateNKeysBetween(null, null, 1);
      expect(keys).toHaveLength(1);
    });

    it('generates n sorted keys between bounds', () => {
      const a = 'a0';
      const b = 'b0';
      const keys = generateNKeysBetween(a, b, 5);
      expect(keys).toHaveLength(5);
      // All within bounds
      for (const k of keys) {
        expect(k > a).toBe(true);
        expect(k < b).toBe(true);
      }
      // Sorted
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i] > keys[i - 1]).toBe(true);
      }
    });

    it('generates n sorted keys after a bound', () => {
      const keys = generateNKeysBetween('a0', null, 5);
      expect(keys).toHaveLength(5);
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i] > keys[i - 1]).toBe(true);
      }
      expect(keys[0] > 'a0').toBe(true);
    });
  });
});
