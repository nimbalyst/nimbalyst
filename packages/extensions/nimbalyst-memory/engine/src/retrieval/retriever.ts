/**
 * Hybrid retriever: dense cosine + BM25 sparse, fused with RRF, plus
 * expand-to-section using the chunk heading breadcrumb. Operates over an
 * in-memory snapshot of stored chunks (rebuilt cheaply when the index changes).
 */
import type { SearchHit, StoredChunk } from '../types.js';
import { cosineSimilarity } from './cosine.js';
import { Bm25Index } from './bm25.js';
import { assertRankSensitive, DEFAULT_K, reciprocalRankFusion } from './rrf.js';

const DENSE_CANDIDATES = 50;
const SPARSE_CANDIDATES = 50;
const PAGE_CANDIDATES = 20;

/**
 * Tunable fusion parameters.
 *
 * Exposed as a constructor option so the evaluation harness can sweep them as
 * arms rather than by editing constants — every default below is a golden-set
 * measurement, and the harness is how the next person re-checks it.
 */
export interface FusionConfig {
  /** RRF rank-saturation constant. See `rrf.ts` for why this is pool-relative. */
  rrfK: number;
  /** Weight on the dense (embedding cosine) arm. */
  denseWeight: number;
  /** Weight on the sparse (BM25) arm. */
  sparseWeight: number;
  /**
   * Weight on the page-level arm (amendment A2). Zero disables it entirely,
   * which is the shipped default — see `DEFAULT_FUSION`.
   */
  pageWeight: number;
  /** How many page-level candidates enter fusion when the arm is enabled. */
  pageCandidates: number;
  /** How many candidates each arm contributes to fusion. */
  denseCandidates: number;
  sparseCandidates: number;
  /**
   * Skip the rank-sensitivity guard. ONLY for the evaluation harness, which
   * needs to score the historical consensus-dominated configuration to show
   * what the fix bought. Never set this in shipped retrieval.
   */
  allowRankInsensitive?: boolean;
}

/**
 * Measured against the golden set (53 questions, openai text-embedding-3-small)
 * via `npm run memory:eval`. Re-derive these rather than reuse them after an
 * embedder change: they were tuned against 1536-dim vectors, and a smaller
 * model has a different score distribution and a weaker dense arm.
 *
 * `k = 8` and `sparseWeight = 0.5` sit in the MIDDLE of a plateau (k 2..20 x
 * sparseWeight 0.3..0.6 all score 54.7-56.6% recall@5 with no source class
 * falling below both input arms), not on its maximum. That is deliberate: at
 * n=53 the difference between the plateau's best and middle cell is one
 * question, so picking the argmax would be fitting noise.
 */
export const DEFAULT_FUSION: FusionConfig = {
  rrfK: DEFAULT_K,
  denseWeight: 1,
  sparseWeight: 0.5,
  // Amendment A2's page-level arm: implemented, measured, and left OFF.
  //
  // It is directionally positive but not distinguishable from zero at n=53 —
  // paired bootstrap vs this two-arm config gives +5.7pp recall@5
  // [-3.8, +15.1] at its best weight, and MRR peaks at a DIFFERENT weight
  // (0.4) than recall does (0.5), which is what noise looks like rather than
  // an effect. It also consistently costs the `rules` class (77.8% -> 55.6%).
  //
  // The rows are still indexed and the arm still works, so re-testing it
  // against a larger golden set or a new embedder is a weight change, not a
  // re-implementation: run `--arms=rrf,rrf-page0.4,rrf-page0.5`.
  pageWeight: 0,
  denseCandidates: DENSE_CANDIDATES,
  sparseCandidates: SPARSE_CANDIDATES,
  pageCandidates: PAGE_CANDIDATES,
};

function citation(c: { sourcePath: string; headingPath: string[] }): string {
  const heading = c.headingPath[c.headingPath.length - 1];
  return heading ? `${c.sourcePath}#${heading}` : c.sourcePath;
}

export class Retriever {
  private chunks: StoredChunk[];
  private byId = new Map<string, StoredChunk>();
  private bm25: Bm25Index;
  private fusion: FusionConfig;
  /** Page-level rows (A2), kept apart from `chunks`. Only embedded ones. */
  private pages: StoredChunk[] = [];
  /** Chunks grouped by source, for resolving a page hit to a citable section. */
  private chunksBySource = new Map<string, StoredChunk[]>();

  constructor(chunks: StoredChunk[], fusion?: Partial<FusionConfig>) {
    // Page rows are a separate retrieval arm, not extra chunks. They must stay
    // out of `chunks` (and therefore out of BM25, cosine, expandSection and the
    // returned hits) or every source would surface twice and the whole first
    // 8 KB of a document would compete with its own sections.
    this.chunks = chunks.filter((c) => c.granularity !== 'page');
    this.pages = chunks.filter((c) => c.granularity === 'page' && c.denseEmbedding?.length);
    for (const c of this.chunks) this.byId.set(c.id, c);
    for (const c of this.chunks) {
      const list = this.chunksBySource.get(c.sourcePath);
      if (list) list.push(c);
      else this.chunksBySource.set(c.sourcePath, [c]);
    }
    this.bm25 = new Bm25Index(this.chunks.map((c) => ({ id: c.id, tf: c.sparseTerms })));
    this.fusion = { ...DEFAULT_FUSION, ...fusion };
    // Fail at construction, not silently at rank time: a pool-depth or k change
    // that makes fusion a consensus vote produces no error and no visible
    // symptom, just a permanently worse ranking.
    if (!this.fusion.allowRankInsensitive) {
      assertRankSensitive(
        this.fusion.rrfK,
        Math.max(this.fusion.denseCandidates, this.fusion.sparseCandidates),
        this.armWeights()
      );
    }
  }

  get size(): number {
    return this.chunks.length;
  }

  /** Weights of the arms actually in play; a zero-weight arm is not fused. */
  private armWeights(): number[] {
    const w = [this.fusion.denseWeight, this.fusion.sparseWeight];
    if (this.fusion.pageWeight > 0) w.push(this.fusion.pageWeight);
    return w;
  }

  /**
   * Rank page-level rows (A2), then resolve each to a citable chunk.
   *
   * A page vector says "this DOCUMENT is relevant", which is not an answer: the
   * caller needs a section it can quote and open. So each retrieved page is
   * mapped to its best-matching chunk by cosine, and it is that chunk's id that
   * enters fusion, at the page's rank. Without this the arm would return hits
   * with no heading, which no caller — and no golden target — can match.
   */
  private pageRanked(
    queryVector: number[],
    inScope: (c: StoredChunk) => boolean
  ): string[] {
    const ranked = this.pages
      .filter((p) => inScope(p))
      .map((p) => ({ p, s: cosineSimilarity(queryVector, p.denseEmbedding!) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, this.fusion.pageCandidates);

    const ids: string[] = [];
    const seen = new Set<string>();
    for (const { p } of ranked) {
      const candidates = (this.chunksBySource.get(p.sourcePath) ?? []).filter(
        (c) => inScope(c) && c.denseEmbedding?.length
      );
      if (!candidates.length) continue;
      let best = candidates[0];
      let bestScore = -Infinity;
      for (const c of candidates) {
        const s = cosineSimilarity(queryVector, c.denseEmbedding!);
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      }
      if (seen.has(best.id)) continue;
      seen.add(best.id);
      ids.push(best.id);
    }
    return ids;
  }

  /**
   * @param queryVector dense query embedding (same embedder as the index), or
   *   null to run sparse-only (e.g. before any embedding is available).
   * @param opts.sourceClasses restrict retrieval to these source classes (e.g.
   *   `['sessions']`). Applied BEFORE the dense/sparse candidate cap so a small
   *   class isn't crowded out of the (capped) global candidate pool by a large
   *   one — the difference between "find a session about X" working or not.
   */
  search(
    queryText: string,
    queryVector: number[] | null,
    k = 5,
    opts?: { sourceClasses?: string[] },
  ): SearchHit[] {
    const allowed =
      opts?.sourceClasses && opts.sourceClasses.length ? new Set(opts.sourceClasses) : null;
    const inScope = (c: StoredChunk): boolean => !allowed || allowed.has(c.sourceClass);

    // Raw per-arm scores are kept alongside the ranks. RRF output is a rank
    // reciprocal, not a similarity: it is not comparable across queries, so a
    // caller that needs a threshold ("close enough to warn about a duplicate")
    // cannot get one from `score`. `similarity` carries the raw numbers.
    const denseScores = new Map<string, number>();
    const denseRanked =
      queryVector && queryVector.length
        ? this.chunks
            .filter((c) => inScope(c) && c.denseEmbedding && c.denseEmbedding.length)
            .map((c) => ({ id: c.id, s: cosineSimilarity(queryVector, c.denseEmbedding!) }))
            .sort((a, b) => b.s - a.s)
            .slice(0, this.fusion.denseCandidates)
            .map((x) => {
              denseScores.set(x.id, x.s);
              return x.id;
            })
        : [];

    const sparseScores = new Map<string, number>();
    const sparseRanked = this.bm25
      .search(queryText)
      .filter((x) => {
        const c = this.byId.get(x.id);
        return c ? inScope(c) : false;
      })
      .slice(0, this.fusion.sparseCandidates)
      .map((x) => {
        sparseScores.set(x.id, x.score);
        return x.id;
      });

    // Membership sets for per-hit signal provenance (semantic vs keyword).
    const denseSet = new Set(denseRanked);
    const sparseSet = new Set(sparseRanked);

    const pageRanked =
      this.fusion.pageWeight > 0 && queryVector && queryVector.length
        ? this.pageRanked(queryVector, inScope)
        : [];

    const fused = reciprocalRankFusion(
      [
        { ids: denseRanked, weight: this.fusion.denseWeight },
        { ids: sparseRanked, weight: this.fusion.sparseWeight },
        ...(pageRanked.length
          ? [{ ids: pageRanked, weight: this.fusion.pageWeight }]
          : []),
      ],
      this.fusion.rrfK
    );

    const hits: SearchHit[] = [];
    for (const { id, score } of fused.slice(0, k)) {
      const c = this.byId.get(id);
      if (!c) continue;
      hits.push({
        sourcePath: c.sourcePath,
        sourceClass: c.sourceClass,
        refType: c.refType,
        refId: c.refId,
        headingPath: c.headingPath,
        text: c.text,
        score,
        citation: citation(c),
        signals: { dense: denseSet.has(id), sparse: sparseSet.has(id) },
        similarity: {
          ...(denseScores.has(id) ? { cosine: denseScores.get(id)! } : {}),
          ...(sparseScores.has(id) ? { bm25: sparseScores.get(id)! } : {}),
        },
      });
    }
    return hits;
  }

  /**
   * Expand a hit to its full heading section: all chunks in the same source
   * whose heading breadcrumb is the matched path (or a descendant of it),
   * concatenated in document order.
   */
  expandSection(sourcePath: string, headingPath: string[]): {
    sourcePath: string;
    headingPath: string[];
    text: string;
  } | null {
    const inSource = this.chunks
      .filter((c) => c.sourcePath === sourcePath)
      .sort((a, b) => a.ordinal - b.ordinal);
    if (inSource.length === 0) return null;

    const key = headingPath.join('\u0000');
    const matching = inSource.filter((c) => {
      const ck = c.headingPath.join('\u0000');
      return ck === key || ck.startsWith(key + '\u0000');
    });
    const section = matching.length ? matching : inSource;
    return {
      sourcePath,
      headingPath,
      text: section.map((c) => c.text).join('\n\n'),
    };
  }
}
