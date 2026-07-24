/**
 * Lexicographic fractional indexing for manual ordering.
 *
 * Generates string keys that sort lexicographically between any two existing keys.
 * Used by the tracker kanban board for drag-to-reorder.
 *
 * Based on the algorithm from https://observablehq.com/@dgreensp/implementing-fractional-indexing
 */

const BASE_62_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function midpoint(a: string, b: string | undefined): string {
  // Find the midpoint string between a and b (lexicographically).
  // a < b must hold. b may be undefined (meaning "infinity").
  let result = '';
  const maxLen = b ? Math.max(a.length, b.length) : a.length;

  for (let i = 0; i <= maxLen; i++) {
    const charA = i < a.length ? BASE_62_DIGITS.indexOf(a[i]) : 0;
    const charB = b && i < b.length ? BASE_62_DIGITS.indexOf(b[i]) : 62;

    if (charA === charB) {
      result += BASE_62_DIGITS[charA];
      continue;
    }

    const mid = Math.floor((charA + charB) / 2);
    if (mid > charA) {
      return result + BASE_62_DIGITS[mid];
    }
    // charA and charB are adjacent; append charA and continue with next digit
    result += BASE_62_DIGITS[charA];
  }

  // Should not reach here in normal usage
  return result + BASE_62_DIGITS[31];
}

/**
 * Generate a sort key between `a` and `b`.
 * - `generateKeyBetween(null, null)` -> initial key (e.g. "a0")
 * - `generateKeyBetween(null, first)` -> key before `first`
 * - `generateKeyBetween(last, null)` -> key after `last`
 * - `generateKeyBetween(a, b)` -> key between `a` and `b`
 */
export function generateKeyBetween(a: string | null, b: string | null): string {
  if (a === null && b === null) {
    return 'a0';
  }
  if (a === null) {
    // Generate key before b
    const bFirst = BASE_62_DIGITS.indexOf(b![0]);
    if (bFirst > 1) {
      return BASE_62_DIGITS[Math.floor(bFirst / 2)];
    }
    // b starts with '0' or '1', need to go deeper
    return midpoint('', b!);
  }
  if (b === null) {
    // Generate key after a
    const aLast = a[a.length - 1];
    const aLastIdx = BASE_62_DIGITS.indexOf(aLast);
    if (aLastIdx < 61) {
      return a.slice(0, -1) + BASE_62_DIGITS[aLastIdx + 1];
    }
    // Last char is 'z' (61), append a middle char
    return a + BASE_62_DIGITS[31];
  }

  // Between a and b
  return midpoint(a, b);
}

/**
 * Generate `n` evenly-spaced keys between `a` and `b`.
 */
export function generateNKeysBetween(a: string | null, b: string | null, n: number): string[] {
  if (n === 0) return [];
  if (n === 1) return [generateKeyBetween(a, b)];

  const keys: string[] = [];
  let lo = a;
  for (let i = 0; i < n; i++) {
    const key = generateKeyBetween(lo, b);
    keys.push(key);
    lo = key;
  }
  return keys;
}
