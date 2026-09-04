/**
 * An in-memory index of stored memory pages, answering "what does this new page
 * collide with?" and turning the answer into one action.
 *
 * `classify` returning a `DedupAction` rather than a boolean is the whole point:
 * discard and supersede are different outcomes with different effects on the
 * store, and `related` is a review item rather than either. A caller that only
 * wants "is this new?" can read `action === 'store'`.
 */
import {
  DEFAULT_DEDUP_POLICY,
  decideVerdict,
  similaritySignals,
} from "./compare.js";
import { bandKeys, minhashSignature } from "./minhash.js";
import { profileText, type TextProfile } from "./normalize.js";
import type { DedupDecision, DedupMatch, DedupPolicy } from "./types.js";

/**
 * Below this many entries a full scan is cheaper than banding and cannot miss.
 * A per-workspace memory store sits under it for a long time.
 */
const EXHAUSTIVE_BELOW = 200;

interface Entry {
  id: string;
  profile: TextProfile;
  bands: string[];
}

export interface DedupIndexOptions {
  policy?: DedupPolicy;
  /** Index size at which LSH shortlisting replaces the full scan. */
  exhaustiveBelow?: number;
}

export interface QueryOptions {
  /** Maximum matches returned, best first. Default 5. */
  limit?: number;
  /** Ids to skip — normally the page's own id when re-checking an edit. */
  exclude?: Iterable<string>;
  /** Embedding cosines by id, when an embedder is configured. */
  semanticScores?: ReadonlyMap<string, number>;
}

export class DedupIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly buckets = new Map<string, Set<string>>();
  private readonly policy: DedupPolicy;
  private readonly exhaustiveBelow: number;

  constructor(options: DedupIndexOptions = {}) {
    this.policy = options.policy ?? DEFAULT_DEDUP_POLICY;
    this.exhaustiveBelow = options.exhaustiveBelow ?? EXHAUSTIVE_BELOW;
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Add or replace a page. Re-adding the same id re-profiles it. */
  add(id: string, text: string): void {
    this.remove(id);
    const profile = profileText(text, this.policy.shingleSize);
    const bands = bandKeys(minhashSignature(profile.tokens));
    this.entries.set(id, { id, profile, bands });
    for (const key of bands) {
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = new Set();
        this.buckets.set(key, bucket);
      }
      bucket.add(id);
    }
  }

  remove(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    for (const key of entry.bands) {
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      bucket.delete(id);
      if (bucket.size === 0) this.buckets.delete(key);
    }
    this.entries.delete(id);
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.buckets.clear();
  }

  private candidateIds(
    profile: TextProfile,
    semanticScores?: ReadonlyMap<string, number>
  ): Iterable<string> {
    if (this.entries.size < this.exhaustiveBelow) return this.entries.keys();
    const ids = new Set<string>();
    for (const key of bandKeys(minhashSignature(profile.tokens))) {
      const bucket = this.buckets.get(key);
      if (bucket) for (const id of bucket) ids.add(id);
    }
    // Semantic candidates are already shortlisted by the caller. Union them
    // with the lexical LSH candidates so a true paraphrase cannot disappear at
    // the exhaustive-scan cutoff merely because it shares no MinHash band.
    if (semanticScores) {
      for (const id of semanticScores.keys()) {
        if (this.entries.has(id)) ids.add(id);
      }
    }
    return ids;
  }

  /** Every non-distinct comparison against the stored pages, best first. */
  query(text: string, options: QueryOptions = {}): DedupMatch[] {
    const profile = profileText(text, this.policy.shingleSize);
    const excluded = new Set(options.exclude ?? []);
    const matches: DedupMatch[] = [];

    for (const id of this.candidateIds(profile, options.semanticScores)) {
      if (excluded.has(id)) continue;
      const entry = this.entries.get(id);
      if (!entry) continue;
      const signals = similaritySignals(
        profile,
        entry.profile,
        options.semanticScores?.get(id)
      );
      const comparison = decideVerdict(signals, this.policy);
      if (comparison.verdict === "distinct") continue;
      matches.push({ id, ...comparison, signals });
    }

    matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return matches.slice(0, options.limit ?? 5);
  }

  /**
   * The single answer a write path wants. Precedence is fixed: an outright
   * restatement wins over containment (a near-copy contains its original, and
   * retiring the original for a copy of itself would be wrong), and containment
   * wins over a merely-overlapping pair.
   */
  classify(text: string, options: QueryOptions = {}): DedupDecision {
    const matches = this.query(text, options);

    const duplicate = matches.find((m) => m.verdict === "duplicate");
    if (duplicate)
      return {
        action: "discard",
        matches,
        supersedes: [],
        duplicateOf: duplicate.id,
      };

    const subsumed = matches.find((m) => m.verdict === "subsumed");
    if (subsumed)
      return {
        action: "discard",
        matches,
        supersedes: [],
        duplicateOf: subsumed.id,
      };

    const supersedes = matches
      .filter((m) => m.verdict === "supersedes")
      .map((m) => m.id);
    if (supersedes.length > 0)
      return { action: "supersede", matches, supersedes };

    if (matches.length > 0)
      return { action: "review", matches, supersedes: [] };
    return { action: "store", matches, supersedes: [] };
  }
}
