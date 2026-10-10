/**
 * Exact text distances for the diff matchers, sized for long blocks.
 *
 * The matchers compare every candidate pair of siblings, and a long markdown
 * list reaches them as one block whose text is the whole list. The textbook
 * m*n matrices here froze the renderer for ~16s on a ~190KB list-heavy file
 * where an agent renumbered a label on ~110 items (#1606). Both measures
 * below return the same values as the textbook versions, but update 32 DP
 * cells per machine word, so an unrelated pair costs m*n/32 instead of m*n
 * and no m*n matrix is ever allocated. Levenshtein also strips the shared
 * prefix and suffix first, which does not change the distance and reduces a
 * one-label edit to a few characters.
 */

/** Per-code-unit match masks for the 32-code-unit block being processed. */
const peq = new Uint32Array(0x10000);

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function commonSuffix(a: string, b: string, prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}

/** Myers (1999) for a pattern `a` of at most 32 code units. */
function myers32(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  const last = 1 << (n - 1);
  let pv = -1;
  let mv = 0;
  let score = n;
  for (let i = 0; i < n; i++) peq[a.charCodeAt(i)] |= 1 << i;
  for (let j = 0; j < m; j++) {
    let eq = peq[b.charCodeAt(j)];
    const xv = eq | mv;
    eq |= ((eq & pv) + pv) ^ pv;
    mv |= ~(eq | pv);
    pv &= eq;
    if (mv & last) score++;
    if (pv & last) score--;
    mv = (mv << 1) | 1;
    pv = (pv << 1) | ~(xv | mv);
    mv &= xv;
  }
  for (let i = 0; i < n; i++) peq[a.charCodeAt(i)] = 0;
  return score;
}

/**
 * Hyyro's blocked extension of Myers for a pattern `b` longer than 32 code
 * units: `b` is processed in 32-unit vertical blocks, carrying the horizontal
 * deltas for every position of `a` from one block to the next.
 */
function myersBlocked(b: string, a: string): number {
  const n = a.length;
  const m = b.length;
  const hsize = Math.ceil(n / 32);
  const vsize = Math.ceil(m / 32);
  const phc = new Int32Array(hsize).fill(-1);
  const mhc = new Int32Array(hsize);

  let j = 0;
  for (; j < vsize - 1; j++) {
    let mv = 0;
    let pv = -1;
    const start = j * 32;
    const end = start + 32;
    for (let k = start; k < end; k++) peq[b.charCodeAt(k)] |= 1 << k;
    for (let i = 0; i < n; i++) {
      const eq = peq[a.charCodeAt(i)];
      const w = i >>> 5;
      const pb = (phc[w] >>> i) & 1;
      const mb = (mhc[w] >>> i) & 1;
      const xv = eq | mv;
      const xh = ((((eq | mb) & pv) + pv) ^ pv) | eq | mb;
      let ph = mv | ~(xh | pv);
      let mh = pv & xh;
      if ((ph >>> 31) ^ pb) phc[w] ^= 1 << i;
      if ((mh >>> 31) ^ mb) mhc[w] ^= 1 << i;
      ph = (ph << 1) | pb;
      mh = (mh << 1) | mb;
      pv = mh | ~(xv | ph);
      mv = ph & xv;
    }
    for (let k = start; k < end; k++) peq[b.charCodeAt(k)] = 0;
  }

  let mv = 0;
  let pv = -1;
  const start = j * 32;
  const end = m;
  for (let k = start; k < end; k++) peq[b.charCodeAt(k)] |= 1 << k;
  let score = m;
  const top = (m - 1) & 31;
  for (let i = 0; i < n; i++) {
    const eq = peq[a.charCodeAt(i)];
    const w = i >>> 5;
    const pb = (phc[w] >>> i) & 1;
    const mb = (mhc[w] >>> i) & 1;
    const xv = eq | mv;
    const xh = ((((eq | mb) & pv) + pv) ^ pv) | eq | mb;
    let ph = mv | ~(xh | pv);
    let mh = pv & xh;
    score += (ph >>> top) & 1;
    score -= (mh >>> top) & 1;
    if ((ph >>> 31) ^ pb) phc[w] ^= 1 << i;
    if ((mh >>> 31) ^ mb) mhc[w] ^= 1 << i;
    ph = (ph << 1) | pb;
    mh = (mh << 1) | mb;
    pv = mh | ~(xv | ph);
    mv = ph & xv;
  }
  for (let k = start; k < end; k++) peq[b.charCodeAt(k)] = 0;
  return score;
}

/** Levenshtein distance over UTF-16 code units (insert, delete, substitute all cost 1). */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prefix = commonPrefix(a, b);
  const suffix = commonSuffix(a, b, prefix);
  let s = a.slice(prefix, a.length - suffix);
  let t = b.slice(prefix, b.length - suffix);
  if (s.length < t.length) [s, t] = [t, s];
  if (t.length === 0) return s.length;
  // The pattern is the shorter side when it fits one word, else the longer one
  // is split into blocks; both argument orders match the reference usage.
  return t.length <= 32 ? myers32(t, s) : myersBlocked(s, t);
}

/**
 * Longest-common-subsequence lengths against one fixed token sequence `A`.
 *
 * Bit-parallel (Allison-Dix / Hyyro): bit i of `v` is 0 once token i of `A`
 * is matched. Per token of `B`, `v' = (v + u) | (v & ~u)` with `u = v & M[b]`,
 * where the add carries across 32-bit words. The match masks depend only on
 * `A`, so a node compared against every candidate sibling builds them once.
 */
export class LcsPattern<T> {
  private readonly masks = new Map<T, Uint32Array>();
  private readonly v: Uint32Array;
  private readonly length: number;

  constructor(A: readonly T[]) {
    this.length = A.length;
    const words = Math.ceil(A.length / 32);
    this.v = new Uint32Array(words);
    for (let i = 0; i < A.length; i++) {
      let mask = this.masks.get(A[i]);
      if (!mask) {
        mask = new Uint32Array(words);
        this.masks.set(A[i], mask);
      }
      mask[i >>> 5] |= 1 << (i & 31);
    }
  }

  lcsWith(B: readonly T[]): number {
    const m = this.length;
    if (m === 0 || B.length === 0) return 0;
    const v = this.v;
    const words = v.length;
    v.fill(0xffffffff);
    for (let j = 0; j < B.length; j++) {
      const mask = this.masks.get(B[j]);
      if (!mask) continue;
      let carry = 0;
      for (let w = 0; w < words; w++) {
        const vw = v[w];
        const u = vw & mask[w];
        const sum = vw + (u >>> 0) + carry;
        carry = sum > 0xffffffff ? 1 : 0;
        v[w] = (sum | (vw & ~u)) >>> 0;
      }
    }

    let unmatched = 0;
    for (let w = 0; w < words; w++) {
      let bits = v[w];
      if (w === words - 1 && (m & 31) !== 0) bits &= (1 << (m & 31)) - 1;
      bits -= (bits >>> 1) & 0x55555555;
      bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
      unmatched += Math.imul((bits + (bits >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
    }
    return m - unmatched;
  }
}

/** Length of the longest common subsequence of two token sequences. */
export function lcsLength<T>(A: readonly T[], B: readonly T[]): number {
  return new LcsPattern(A).lcsWith(B);
}
