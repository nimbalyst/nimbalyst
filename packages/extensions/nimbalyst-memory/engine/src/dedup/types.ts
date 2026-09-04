/**
 * Types for prose-aware near-duplicate detection.
 *
 * The old candidate filter compared lowercased, whitespace-collapsed strings
 * for equality. That was defensible while a memory was one sentence written by
 * one extractor. Now that a memory's payload is a page of prose, two pages can
 * say the same thing without sharing a single identical line, and exact match
 * finds nothing.
 *
 * The replacement is graded rather than boolean, because "the same" is not one
 * relationship. A page that restates an existing one should be dropped; a page
 * that *contains* an existing one should replace it; a page contained *by* an
 * existing one adds nothing; and a page that merely overlaps is a question for
 * a human. Collapsing those four into `isDuplicate: boolean` is what makes
 * supersede impossible to implement later.
 */

export type DedupVerdict =
  /** Says the same thing as the existing page. Drop the new one. */
  | 'duplicate'
  /** Contains the existing page and adds to it. The new one supersedes it. */
  | 'supersedes'
  /** Contained by the existing page, adding nothing. Drop the new one. */
  | 'subsumed'
  /** Overlaps enough to be worth a human decision, not enough to act on. */
  | 'related'
  /** No meaningful overlap. */
  | 'distinct';

/**
 * The measurements a verdict is derived from, kept separate from the decision
 * so a semantic arm can supply one more number without any caller changing.
 */
export interface SimilaritySignals {
  /** Jaccard over content token sets. Robust to reordering and rewording. */
  tokenJaccard: number;
  /** Jaccard over word k-shingles. Sensitive to phrasing, so near-restatement. */
  shingleJaccard: number;
  /** |new ∩ existing| / |new| — how much of the new page the existing one covers. */
  containmentNewInExisting: number;
  /** |new ∩ existing| / |existing| — how much of the existing page the new one covers. */
  containmentExistingInNew: number;
  /** Distinct-token count of the new page over the existing one. */
  lengthRatio: number;
  /**
   * Optional cosine from an embedding model. Absent on a keyless install, which
   * is the whole reason the lexical arms above have to stand alone.
   */
  semantic?: number;
}

export interface DedupPolicy {
  /** Word k-shingle size. */
  shingleSize: number;
  /** Token-set Jaccard at or above which two pages restate each other. */
  duplicateTokenJaccard: number;
  /** Shingle Jaccard at or above which two pages restate each other. */
  duplicateShingleJaccard: number;
  /** Embedding cosine at or above which two pages restate each other. */
  duplicateSemantic: number;
  /** Containment of the existing page in the new one required to supersede. */
  supersedeContainment: number;
  /** How much longer the new page must be to count as an extension. */
  supersedeLengthRatio: number;
  /** Containment of the new page in the existing one required to call it subsumed. */
  subsumeContainment: number;
  /** How much shorter the new page must be to count as subsumed. */
  subsumeLengthRatio: number;
  /** Best-signal floor below which two pages are unrelated. */
  relatedThreshold: number;
}

export interface DedupComparison {
  verdict: DedupVerdict;
  /** The signal the verdict rested on, 0–1, for ranking matches. */
  score: number;
  /** Short explanation, suitable for the conflicts view. */
  rationale: string;
  signals: SimilaritySignals;
}

export interface DedupMatch extends DedupComparison {
  /** Id of the existing memory this comparison is against. */
  id: string;
}

/** What the caller should do with the incoming page. */
export type DedupAction =
  /** Nothing close enough to matter. */
  | 'store'
  /** An existing page already says this. */
  | 'discard'
  /** Store, and mark the listed ids superseded. */
  | 'supersede'
  /** Ambiguous overlap; send the pair to the review queue. */
  | 'review';

export interface DedupDecision {
  action: DedupAction;
  /** Every non-distinct comparison, best first. */
  matches: DedupMatch[];
  /** Ids this page supersedes, when `action` is `supersede`. */
  supersedes: string[];
  /** The existing page that made this a discard, when `action` is `discard`. */
  duplicateOf?: string;
}
