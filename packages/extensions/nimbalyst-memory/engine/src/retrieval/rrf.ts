/**
 * Reciprocal Rank Fusion: combine several ranked id lists into one ranking,
 * robust to the wildly different score scales of dense cosine vs BM25.
 *
 *   score(id) = Σ_lists weight / (k + rank_in_list)
 *
 * ## `k` must be chosen against the candidate-pool depth, not copied
 *
 * `k` controls how fast rank position stops mattering. The published `k = 60`
 * comes from TREC, where the fused runs are ranked lists of ~1000 documents. It
 * is not a universal constant: it is a constant *relative to pool depth*, and
 * transplanting it onto a shallow pool silently changes what RRF computes.
 *
 * Over a pool of depth `D`, an id's contribution from one list ranges over
 * `w/(k+1)` … `w/(k+D)`. So with `L` lists:
 *
 *   best possible score from ONE list  = w/(k+1)
 *   worst possible score from ALL lists = L·w/(k+D)
 *
 * When `L·w/(k+D) >= w/(k+1)` — i.e. `k >= (D - L) / (L - 1)` for equal weights
 * — every id that appears in every list outranks every id that appears in only
 * one, whatever the ranks. RRF has then degenerated into "how many arms
 * retrieved this", tie-broken by rank, and a document your best arm ranks #1
 * cannot beat a document both arms rank last.
 *
 * That is exactly what the shipped retriever was doing: `k = 60` against
 * `D = 50` and `L = 2` gives a both-arms floor of `2/110 = 0.01818` above the
 * single-arm ceiling of `1/61 = 0.01639`. Consensus strictly dominated rank.
 *
 * `assertRankSensitive` encodes the inequality so a future pool-depth or
 * arm-count change cannot re-introduce it unnoticed.
 */

export interface RankedList {
  /** Ids in rank order (best first). */
  ids: string[];
  /** Optional per-list weight. Default 1. */
  weight?: number;
}

/**
 * Rank-saturation constant. Chosen against a 50-deep pool and measured on the
 * golden set (see `eval/arms.ts`), not inherited from the TREC default — see
 * the header for why the two are not interchangeable.
 */
export const DEFAULT_K = 8;

/**
 * The largest `k` at which a top-ranked hit from a single list can still
 * outrank a hit sitting at the bottom of every list.
 *
 * Above this, fusion is a consensus vote rather than a rank combination.
 */
export function maxRankSensitiveK(poolDepth: number, lists: number): number {
  if (lists <= 1) return Number.POSITIVE_INFINITY;
  // Strict form of k < (D - L) / (L - 1).
  return Math.ceil((poolDepth - lists) / (lists - 1)) - 1;
}

/**
 * True when `k` leaves rank position able to overcome list membership.
 *
 * Weights are accounted for: the check compares the strongest single list's
 * ceiling against the summed floor of all of them, so raising one arm's weight
 * can restore rank sensitivity that equal weights would not have.
 */
export function isRankSensitive(
  k: number,
  poolDepth: number,
  weights: number[] = [1, 1]
): boolean {
  if (weights.length <= 1 || poolDepth <= 1) return true;
  const bestSingle = Math.max(...weights) / (k + 1);
  const allFloor = weights.reduce((sum, w) => sum + w, 0) / (k + poolDepth);
  return bestSingle > allFloor;
}

/**
 * Throw when a fusion configuration cannot express single-arm confidence.
 *
 * Called from the retriever so a change to `DENSE_CANDIDATES`, the arm count,
 * or `k` fails loudly at construction instead of quietly turning the ranker
 * into a consensus vote — the failure mode is invisible in output, it just
 * scores slightly worse forever.
 */
export function assertRankSensitive(
  k: number,
  poolDepth: number,
  weights: number[]
): void {
  if (isRankSensitive(k, poolDepth, weights)) return;
  throw new Error(
    `RRF k=${k} is too large for a ${poolDepth}-deep pool across ${weights.length} arms ` +
      `(weights ${weights.join(', ')}): every hit found by all arms would outrank every ` +
      `hit found by one, regardless of rank. Use k <= ${maxRankSensitiveK(poolDepth, weights.length)}.`
  );
}

export function reciprocalRankFusion(
  lists: RankedList[],
  k: number = DEFAULT_K
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const w = list.weight ?? 1;
    for (let rank = 0; rank < list.ids.length; rank++) {
      const id = list.ids[rank];
      scores.set(id, (scores.get(id) ?? 0) + w / (k + rank + 1));
    }
  }
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
