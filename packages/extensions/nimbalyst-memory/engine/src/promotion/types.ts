/**
 * The input contract for promoting a memory into a repository convention.
 *
 * Promotion is the one-way door between the two classes of memory. Class 1 is
 * the mined record: high volume, machine-written, personal by default, living
 * on the tracker substrate. Class 2 is a convention the team must follow, and
 * those already have a home that works — `.claude/rules/*.md`, reviewed through
 * a pull request like any other change. The diff *is* the review, which is the
 * only thing standing between auto-mined noise and team doctrine.
 *
 * These types describe only what that transformation needs, deliberately not
 * the memory record schema. A promoter that imports the store's record type
 * cannot be tested without a store, a database, or a tracker, and it acquires
 * every field that schema grows for unrelated reasons. Keeping the input narrow
 * makes the wiring a small adapter and keeps everything here a pure function
 * over plain data.
 */

/**
 * How often a memory has actually been used. This is the evidence behind
 * "promote this?" and the reason the question can be asked at all: nobody else
 * can see which of their memories earned their keep, because nobody else
 * records retrieval against the work the memory governs.
 */
export interface MemoryRecallStats {
  /** Times the record has been returned by a recall/search. */
  recallCount: number;
  /** Distinct sessions those recalls came from. */
  sessionCount: number;
  /** ISO-8601. Absent means never recalled. */
  lastRecalledAt?: string;
}

/**
 * Whether the record still stands. A memory that something later contradicted
 * or superseded is exactly the memory that must not become a rule, and it is
 * the case a bare recall count cannot see: a wrong fact that keeps getting
 * retrieved looks *more* promotable, not less, until standing is consulted.
 */
export interface MemoryStandingState {
  /** Ids of records that contradict this one. Opaque here; never rendered. */
  contradictedBy?: string[];
  /** Id of the record that replaced this one, if any. */
  supersededBy?: string;
  /** Ids this record itself replaced. Strengthens rather than blocks. */
  supersedes?: string[];
  /** ISO-8601. Archived records are not promotion candidates. */
  archivedAt?: string;
}

/**
 * A memory record reduced to what a rule file is made of.
 *
 * `id` is here so a caller can correlate a plan back to its record. It is
 * never written into the generated file: record ids and `NIM-###` issue keys
 * are scoped to one workspace's tracker room, so a reader elsewhere who looks
 * one up lands on an unrelated item and believes it.
 */
export interface PromotableMemory {
  /** Opaque record id. Used for correlation only, never rendered. */
  id: string;
  /** The rule, stated imperatively, as the `##` heading. */
  title: string;
  /** The rule itself, as markdown prose. */
  body: string;
  /** Why the rule exists — ideally the incident that caused it. */
  why?: string;
  /** Globs the rule applies to. Empty means it always applies. */
  appliesTo?: string[];
  /** Repo-relative docs the rule leans on, rendered as `imports:`. */
  relatedDocs?: string[];
  /** GitHub issue numbers. The only citation form that travels. */
  githubIssues?: number[];
  /** Prose provenance for when there is no issue to cite. */
  sourceNote?: string;
  /** ISO-8601 creation time of the underlying record. */
  createdAt?: string;
  recall?: MemoryRecallStats;
  standing?: MemoryStandingState;
}
