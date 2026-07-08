/**
 * Reciprocal Rank Fusion: combine several ranked id lists into one ranking,
 * robust to the wildly different score scales of dense cosine vs BM25.
 *
 *   score(id) = Σ_lists 1 / (k + rank_in_list)
 */

export interface RankedList {
  /** Ids in rank order (best first). */
  ids: string[];
  /** Optional per-list weight. Default 1. */
  weight?: number;
}

const DEFAULT_K = 60;

export function reciprocalRankFusion(
  lists: RankedList[],
  k: number = DEFAULT_K
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const w = list.weight ?? 1;
    for (let rank = 0; rank < list.ids.length; rank++) {
      const id = list.ids[rank];
      scores.set(id, (scores.get(id) ?? 0) + (w * 1) / (k + rank + 1));
    }
  }
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
