// @vitest-environment node
/**
 * The bit-parallel distances must return exactly what the textbook matrices
 * did: the tree matchers' thresholds were tuned against those values, and a
 * drift would silently change which blocks pair up in an inline diff.
 */
import {describe, expect, it} from 'vitest';

import {lcsLength, levenshteinDistance} from '../../core/textDistance';

function referenceLevenshtein(a: string, b: string): number {
  const dp = Array.from({length: a.length + 1}, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function referenceLcs<T>(A: T[], B: T[]): number {
  const dp = Array.from({length: A.length + 1}, () => new Array<number>(B.length + 1).fill(0));
  for (let i = 1; i <= A.length; i++) {
    for (let j = 1; j <= B.length; j++) {
      dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[A.length][B.length];
}

let seed = 1606;
function rand(n: number): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed % n;
}

/** Random text over a small alphabet (so matches are common), with an optional edit pass. */
function randomText(length: number, alphabet: string): string {
  let s = '';
  for (let i = 0; i < length; i++) s += alphabet[rand(alphabet.length)];
  return s;
}

function mutate(s: string, edits: number, alphabet: string): string {
  const chars = [...s];
  for (let e = 0; e < edits; e++) {
    const at = rand(chars.length + 1);
    const kind = rand(3);
    if (kind === 0) chars.splice(at, 0, alphabet[rand(alphabet.length)]);
    else if (kind === 1 && chars.length) chars.splice(Math.min(at, chars.length - 1), 1);
    else if (chars.length) chars[Math.min(at, chars.length - 1)] = alphabet[rand(alphabet.length)];
  }
  return chars.join('');
}

// Lengths straddle the 32-unit word boundary and multi-word blocks on both sides.
const LENGTHS = [0, 1, 2, 31, 32, 33, 63, 64, 65, 97, 150, 300];

describe('levenshteinDistance', () => {
  it('matches the textbook matrix for related and unrelated pairs across word boundaries', () => {
    for (const alphabet of ['ab', 'abcdefgh', 'the quick brown foxé中']) {
      for (const la of LENGTHS) {
        for (const lb of LENGTHS) {
          const a = randomText(la, alphabet);
          const unrelated = randomText(lb, alphabet);
          expect(levenshteinDistance(a, unrelated), `${la}x${lb} unrelated`).toBe(referenceLevenshtein(a, unrelated));
          const related = mutate(a, 1 + rand(8), alphabet);
          expect(levenshteinDistance(a, related), `${la} related`).toBe(referenceLevenshtein(a, related));
        }
      }
    }
  });
});

describe('lcsLength', () => {
  it('matches the textbook matrix for token sequences across word boundaries', () => {
    const vocab = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    for (const la of LENGTHS) {
      for (const lb of LENGTHS) {
        const A = Array.from({length: la}, () => vocab[rand(vocab.length)]);
        const B = Array.from({length: lb}, () => vocab[rand(vocab.length)]);
        expect(lcsLength(A, B), `${la}x${lb} unrelated`).toBe(referenceLcs(A, B));
        const related = mutate(A.join(''), 1 + rand(8), 'abcdefghij').split('');
        expect(lcsLength(A, related), `${la} related`).toBe(referenceLcs(A, related));
      }
    }
  });
});
