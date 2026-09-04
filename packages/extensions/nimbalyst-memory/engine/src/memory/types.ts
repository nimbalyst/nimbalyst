/**
 * Fact model v3 — the record behind a `memory` tracker item.
 *
 * Two things about this file are load-bearing and neither is obvious from the
 * field list.
 *
 * **1. The durable unit is a page, not a sentence.** A memory's payload is
 * `body`: prose that carries its own context and can be read on its own. The
 * seven `MemoryType` values are facets *over* a page, not a replacement for
 * one. v1 went the other way — it instructed the extractor that "each fact is
 * one self-contained sentence understandable without the source" and capped
 * candidates at 300 characters — and that context-stripping is the thing this
 * model exists to make unreachable. See {@link MEMORY_PAGE_MIN_CHARS}.
 *
 * **2. Volatile fields are separated at the type level, not by convention.**
 * `recallCount` / `lastRecalledAt` change on every search. A committed replica
 * carrying them would be rewritten constantly and conflict on every branch,
 * which would destroy the append-only merge profile that is the entire reason
 * the replica is safe to commit. So they live in {@link VolatileMemoryFields},
 * which the replica projection cannot reach: entry to the replica is an
 * allowlist derived from {@link DurableMemoryFields}, and a volatile field is
 * not a key of that interface. See `replica.ts`.
 */

/** Schema version stamped on every record; `3` is fact model v3. */
export const MEMORY_SCHEMA_VERSION = 3;

/** The seven coding-shaped facets a page can carry. */
export type MemoryType =
  | 'decision'
  | 'preference'
  | 'instruction'
  | 'convention'
  | 'constraint'
  | 'error'
  | 'fact';

export const MEMORY_TYPES: readonly MemoryType[] = [
  'decision',
  'preference',
  'instruction',
  'convention',
  'constraint',
  'error',
  'fact',
];

/**
 * Who can see this page. `personal` never reaches a shared repo or a team
 * room; `project` is the workspace's own memory; `team` is published to the
 * tracker room and read by every teammate's agent.
 */
export type MemoryScope = 'personal' | 'project' | 'team';

/**
 * Lifecycle position. Distinct from the *conflict* outcome computed at read
 * time — `superseded` here is a persisted projection of the `supersedes` links,
 * not the thing that decides them. See `resolve.ts`.
 */
export type MemoryStatus = 'candidate' | 'active' | 'superseded' | 'archived';

/** How the page came to exist. Structured, because provenance display is the
 * only detection mechanism for a bad team memory (plan decision 5) and a free
 * string cannot be rendered as a link back to the session that wrote it. */
export interface MemoryProvenance {
  kind: 'user' | 'distilled' | 'promoted' | 'imported';
  /** Session that produced the page, when there was one. */
  sessionId?: string;
  /** Where an imported or migrated page came from (e.g. a markdown path). */
  sourcePath?: string;
  /** Display name / email of the author, for the team browser. */
  author?: string;
}

/**
 * Everything that reaches the JSONL replica. Timestamps are ISO-8601 UTC
 * strings, never epoch millis, because the replica is diffed by humans and git.
 */
export interface DurableMemoryFields {
  /** Stable, content-derived id. Sort key for the replica. */
  factId: string;
  schemaVersion: number;
  /** One-line heading for the page; the tracker item's title. */
  title: string;
  /** The page itself — prose with its own context (decision 7). */
  body: string;
  type: MemoryType;
  scope: MemoryScope;
  status: MemoryStatus;
  /** 0–1. Distilled pages start lower than user-authored ones. */
  confidence: number;
  provenance: MemoryProvenance;
  /** When the page's claim started being true (bi-temporal, not write time). */
  validFrom: string;
  /** When it stopped. Set once, on supersede. Null while it still holds. */
  validTo: string | null;
  /** factIds this page explicitly retires. */
  supersedes: string[];
  /** factIds this page overlaps without retiring — the conflict-review pairs. */
  duplicates: string[];
  /** Type-defaulted, user-overridable expiry. Null means it does not expire. */
  expiresAt: string | null;
  /** Write time, as opposed to `validFrom`. */
  createdAt: string;
  /** Last write; the tiebreak for replica reconcile (newest wins). */
  updatedAt: string;
  /** Tombstone. A deleted record stays in the replica as a line, never absent. */
  deletedAt: string | null;
  /** True when the redaction gate rewrote the body before storage. A reviewer
   * needs to know the page was altered; it is a property of the page, not of
   * how often it was read, so it belongs in the replica. */
  redacted: boolean;
}

/**
 * Database-only. Never in the replica, never in the committed file — see the
 * module doc. Kept as its own interface so the exclusion is enforced by the
 * compiler rather than remembered by whoever writes the exporter.
 */
export interface VolatileMemoryFields {
  /** Times this page was returned by a recall. The only honest input to decay. */
  recallCount: number;
  lastRecalledAt: string | null;
}

/** A memory record as it exists in the database. */
export interface MemoryRecord extends DurableMemoryFields, VolatileMemoryFields {}

/** A memory record as it exists in the JSONL replica. Volatile fields absent. */
export type MemoryReplicaRecord = DurableMemoryFields;

/**
 * The replica allowlist, and the pinned key order the exporter serialises in.
 *
 * Typed as a *total* map over `DurableMemoryFields`, which buys two compile
 * errors that a comment could not:
 *
 * - Adding a durable field and forgetting it here fails to satisfy the mapped
 *   type, so it cannot silently vanish from the replica.
 * - Adding a volatile field here is an excess property, so `recallCount` can
 *   never be let in by an edit that "just needed it for one export".
 */
export const DURABLE_MEMORY_FIELDS: { readonly [K in keyof DurableMemoryFields]: true } = {
  factId: true,
  schemaVersion: true,
  title: true,
  body: true,
  type: true,
  scope: true,
  status: true,
  confidence: true,
  provenance: true,
  validFrom: true,
  validTo: true,
  supersedes: true,
  duplicates: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  redacted: true,
};

/** The mirror of the above, for the storage layer and for tests to assert on. */
export const VOLATILE_MEMORY_FIELDS: { readonly [K in keyof VolatileMemoryFields]: true } = {
  recallCount: true,
  lastRecalledAt: true,
};

/**
 * Floor on a stored page, in characters of body text.
 *
 * The number is chosen against a specific historical ceiling rather than by
 * taste: v1's extractor capped a candidate at 300 characters, so a floor above
 * 300 means **nothing that pipeline can emit is storable**. The one-liner is
 * not discouraged here, it is unrepresentable. Phase 8's rewritten distillation
 * has to clear this bar, which is the point of setting it before that phase
 * rather than during it.
 */
export const MEMORY_PAGE_MIN_CHARS = 320;

/** A page also has to be more than one sentence, for the same reason. */
export const MEMORY_PAGE_MIN_SENTENCES = 2;

/**
 * Soft ceiling (~8 KB), matching the page-vector window. Deliberately NOT
 * enforced: whether an oversize page is ever refused is an open question the
 * plan defers to phase 6, so the write path reports it as a warning and the
 * health view decides what to do about it.
 */
export const MEMORY_PAGE_SOFT_LIMIT_BYTES = 8192;

/**
 * Default confidence by provenance. Distilled pages start below user-authored
 * ones so ranking can prefer what a human actually said.
 */
export const DEFAULT_CONFIDENCE: Record<MemoryProvenance['kind'], number> = {
  user: 0.9,
  promoted: 0.9,
  imported: 0.6,
  distilled: 0.5,
};
