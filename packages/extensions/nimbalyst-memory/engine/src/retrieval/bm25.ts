/**
 * BM25 sparse keyword scoring. Tokenization keeps dotted/slashed/underscored
 * runs intact (so `foo.ts`, `src/main`, `loadSessionContext` survive as terms)
 * which is exactly where pure dense retrieval is weak.
 */

const TOKEN_RE = /[a-z0-9][a-z0-9_./-]*/gi;
const K1 = 1.5;
const B = 0.75;

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(TOKEN_RE);
  if (!matches) return [];
  return matches.filter((t) => t.length >= 2 || /[0-9]/.test(t));
}

/**
 * Term -> frequency map for one document.
 *
 * Uses a prototype-less object so tokens that collide with `Object.prototype`
 * members ("constructor", "toString", "hasOwnProperty", "__proto__", …) are
 * counted correctly. With a plain `{}`, `tf["constructor"] ?? 0` returns the
 * Object constructor function and `+ 1` builds a STRING — which then poisons
 * doc-length math and turns BM25's `avgdl` into NaN, silently killing keyword
 * retrieval for EVERY query. These tokens are common in code documentation.
 */
export function termFrequencies(text: string): Record<string, number> {
  const tf: Record<string, number> = Object.create(null);
  for (const t of tokenize(text)) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}

/** Safe own-property numeric read (tf maps may be JSON-revived with a prototype). */
function tfCount(tf: Record<string, number>, term: string): number {
  const v = Object.prototype.hasOwnProperty.call(tf, term) ? tf[term] : 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export interface Bm25Doc {
  id: string;
  /** Precomputed term frequencies (from termFrequencies at index time). */
  tf: Record<string, number>;
}

export interface Bm25Scored {
  id: string;
  score: number;
}

/**
 * Brute-force BM25 over an in-memory doc set. Recomputes IDF/avgdl on
 * construction; cheap at a few thousand chunks.
 */
export class Bm25Index {
  private docs: Bm25Doc[];
  private docLen = new Map<string, number>();
  private df = new Map<string, number>();
  private avgdl = 0;

  constructor(docs: Bm25Doc[]) {
    this.docs = docs;
    let total = 0;
    for (const d of docs) {
      let len = 0;
      for (const term in d.tf) {
        if (!Object.prototype.hasOwnProperty.call(d.tf, term)) continue;
        const c = tfCount(d.tf, term);
        if (c <= 0) continue;
        len += c;
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
      this.docLen.set(d.id, len);
      total += len;
    }
    this.avgdl = docs.length ? total / docs.length : 0;
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    // BM25+ style non-negative idf.
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Score every doc against the query; returns matches sorted desc. */
  search(query: string): Bm25Scored[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.avgdl === 0) return [];
    const queryTerms = Array.from(new Set(terms));
    const results: Bm25Scored[] = [];
    for (const d of this.docs) {
      const len = this.docLen.get(d.id) ?? 0;
      let score = 0;
      for (const term of queryTerms) {
        const f = tfCount(d.tf, term);
        if (!f) continue;
        const idf = this.idf(term);
        const denom = f + K1 * (1 - B + (B * len) / this.avgdl);
        score += idf * ((f * (K1 + 1)) / denom);
      }
      if (score > 0) results.push({ id: d.id, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }
}
