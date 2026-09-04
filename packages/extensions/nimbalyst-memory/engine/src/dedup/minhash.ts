/**
 * MinHash + LSH banding, used only to shortlist candidates. Scoring is always
 * exact set arithmetic afterwards, so an approximation error here costs a
 * comparison, never a wrong verdict.
 *
 * Band geometry is chosen for `supersedes`, not for `duplicate`. A page three
 * times longer than the one it extends has containment 1.0 but Jaccard around
 * 0.33, so a conventional 16x4 banding (detection threshold ~0.5) would filter
 * out exactly the case the plan treats as first-class. 32 bands of 2 rows puts
 * the threshold near 0.18: more candidates survive to exact scoring, which is
 * the cheap direction to be wrong in.
 *
 * Stdlib only — no hashing dependency, and no `node:crypto` digest per shingle,
 * which would dominate the cost of the scan it is meant to avoid.
 */

export const NUM_PERM = 64;
export const BANDS = 32;
export const ROWS = NUM_PERM / BANDS;

/** FNV-1a, 32-bit. Fast, well-distributed enough for permutation seeding. */
function fnv1a(value: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  // Final avalanche; FNV alone leaves low-bit structure that banding would see.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507) >>> 0;
  hash ^= hash >>> 13;
  return hash >>> 0;
}

/** Minimum hash per permutation. An empty set yields an all-max signature. */
export function minhashSignature(values: Iterable<string>, numPerm = NUM_PERM): Uint32Array {
  const sig = new Uint32Array(numPerm).fill(0xffffffff);
  for (const value of values) {
    for (let p = 0; p < numPerm; p += 1) {
      const h = fnv1a(value, p);
      if (h < sig[p]!) sig[p] = h;
    }
  }
  return sig;
}

/** One key per band; two sets sharing any key are candidate neighbours. */
export function bandKeys(signature: Uint32Array, bands = BANDS, rows = ROWS): string[] {
  const keys: string[] = [];
  for (let b = 0; b < bands; b += 1) {
    let key = `${b}`;
    for (let r = 0; r < rows; r += 1) key += `:${signature[b * rows + r]}`;
    keys.push(key);
  }
  return keys;
}
