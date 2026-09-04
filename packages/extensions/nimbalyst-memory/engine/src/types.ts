/**
 * Core engine types. Host-agnostic — no Nimbalyst, voice, or tracker concepts
 * leak in here. A "source class" is just a free-form string tag the caller
 * attaches to a set of globs (e.g. "design", "docs", "facts"); the engine never
 * interprets it.
 */
import type { SourceRoot } from './roots.js';

/** A heading-aware slice of a markdown document, ready to embed and store. */
export interface Chunk {
  /** Stable within a (sourcePath): `${sourcePath}#${ordinal}`. */
  id: string;
  /**
   * POSIX path relative to the primary engine root, or `@<rootId>/<rel>` for a
   * source set with its own root. Unique across roots — see `roots.ts`.
   */
  sourcePath: string;
  /** Free-form caller tag for the source set this file belongs to. */
  sourceClass: string;
  /** Breadcrumb of enclosing headings, outermost first. */
  headingPath: string[];
  /** The chunk body (may include the section's heading line for the first chunk). */
  text: string;
  /** SHA-256 of `text`, used as the incremental dirty check. */
  contentHash: string;
  /** Per-file sequence number; combined with sourcePath forms `id`. */
  ordinal: number;
  /**
   * What kind of openable entity this chunk belongs to. `'doc-file'` for on-disk
   * markdown; host-defined otherwise (e.g. `'tracker'`, `'session'`). The engine
   * never interprets it — it just round-trips it onto hits so the caller can
   * route the open action.
   */
  refType: string;
  /**
   * Opaque, openable identifier for the entity (e.g. a tracker id, a session
   * id, or — for `'doc-file'` — the file's `sourcePath`). A file under a
   * non-primary root carries its ABSOLUTE path instead: it is not reachable by
   * joining the workspace path, which is how callers resolve a relative one.
   */
  refId: string;
  /**
   * Retrieval granularity of this row (amendment A2 of the memory-v3 plan).
   *
   * `'chunk'` — a heading-aware slice, the unit everything already used.
   * `'page'` — one row covering the source's first `PAGE_VECTOR_BYTES`, stored
   * alongside its chunks so a whole-document embedding can act as a THIRD
   * fusion arm. It is never a replacement: this corpus contains documents far
   * past any embedding window, so the tail of a long page is simply not
   * represented and chunk rows remain the only complete coverage.
   *
   * Absent on rows written before the column existed; treat as `'chunk'`.
   */
  granularity?: ChunkGranularity;
}

export type ChunkGranularity = 'chunk' | 'page';

/**
 * How much of a source the page-level vector covers. The amendment proposes
 * ~8 KB, which is also the soft page-size limit discussed for authored memory
 * pages, and comfortably inside a typical embedding context window.
 */
export const PAGE_VECTOR_BYTES = 8192;

/** A chunk as persisted, carrying its embedding + provenance. */
export interface StoredChunk extends Chunk {
  /** Dense vector; length === dims. Null until embedded. */
  denseEmbedding: number[] | null;
  /** Lowercased term -> frequency, for BM25. */
  sparseTerms: Record<string, number>;
  embedderId: string;
  model: string;
  dims: number;
  /** Epoch millis of last write. */
  updatedAt: number;
}

/**
 * A record to index that does NOT live on disk — a tracker item, an AI session,
 * etc. The host assembles the text from the database; the engine chunks, embeds,
 * and stores it exactly like a file. Kept host-agnostic: the engine never knows
 * what a "tracker" is, only that it has text and an openable `refType`/`refId`.
 *
 * `id` MUST be globally unique across ALL records and file source paths — the
 * host namespaces it (e.g. `tracker:<uuid>`). It doubles as the synthetic source
 * path (so chunk ids are `${id}#${ordinal}`) and as the delete key for
 * `removeRecords`.
 */
export interface VirtualRecord {
  id: string;
  /** Free-form coverage tag (e.g. `'trackers'`, `'sessions'`). */
  sourceClass: string;
  /** Openable-entity kind echoed onto hits (e.g. `'tracker'`, `'session'`). */
  refType: string;
  /** Openable identifier echoed onto hits (e.g. the tracker id). */
  refId: string;
  /** Optional title; indexed as the record's top heading for better retrieval. */
  title?: string;
  /** Body text to index (plain text or markdown). */
  text: string;
}

/** Identity of the vectors in the store; switching any field forces re-index. */
export interface EmbedderInfo {
  /** Stable id, e.g. "openai" or "local". */
  id: string;
  /** Model name, e.g. "text-embedding-3-small" or "Xenova/bge-m3". */
  model: string;
  /** Vector dimensionality. */
  dims: number;
}

/**
 * Pluggable embedding backend. Implementations MUST be deterministic about
 * `info` (the store keys on it) and return one vector per input text.
 */
export interface Embedder {
  readonly info: EmbedderInfo;
  /** Embed a batch of texts; result[i] corresponds to texts[i]. */
  embed(texts: string[]): Promise<number[][]>;
}

/** One indexable source set: a class tag plus the globs that feed it. */
export interface SourceSet {
  sourceClass: string;
  /** Glob patterns relative to this set's root (fast-glob syntax). */
  include: string[];
  /**
   * Optional root these globs resolve against, for content that does not live
   * under `EngineConfig.root` (e.g. the harness memory directory in the user's
   * home). Omit for the primary root — the common case.
   *
   * A non-primary root changes the shape of every `sourcePath` derived from it:
   * it is prefixed `@<rootId>/`, because relative-to-root alone stops being
   * unique once there is more than one root. See `roots.ts`.
   */
  root?: SourceRoot;
}

export interface EngineConfig {
  /**
   * Absolute PRIMARY root. Bare relative `sourcePath`s resolve against it, and
   * it is the root for every source set that does not declare its own.
   */
  root: string;
  /** Absolute path to the SQLite shadow-index file. Rebuildable; deletable. */
  dbPath: string;
  /** Source sets to index. */
  sources: SourceSet[];
  /**
   * Global ignore globs (fast-glob/picomatch syntax) applied on top of the
   * built-in node_modules/.git/dist ignores. Use to keep stale or archived
   * markdown (e.g. `**​/archive/**`) out of the index so retrieval surfaces
   * current truth, not abandoned plans.
   */
  exclude?: string[];
  /** Directory (relative to root) holding markdown facts. */
  factsDir: string;
  /** Optional explicit better-sqlite3 native binding path (ABI portability). */
  nativeBinding?: string;
  /** Chunking budget. */
  chunk?: { minTokens?: number; maxTokens?: number };
  /**
   * Optional structured log sink. Host-agnostic: the host (or test) wires its
   * own logger. The engine uses this instead of swallowing errors silently
   * (e.g. a failed query embedding that would otherwise degrade search to
   * sparse-only with no trace).
   */
  onLog?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

/** A retrieval hit returned to callers. */
export interface SearchHit {
  sourcePath: string;
  sourceClass: string;
  /** Openable-entity kind for this hit (`'doc-file'` | `'tracker'` | `'session'` | …). */
  refType: string;
  /** Openable identifier (a file path, a tracker id, a session id). */
  refId: string;
  headingPath: string[];
  text: string;
  /** Fused RRF score (higher is better). */
  score: number;
  /** `${sourcePath}#${heading}` style citation. */
  citation: string;
  /**
   * Which retrieval arm(s) surfaced this hit, for explainability in the UI.
   * `dense` = semantic (embedding cosine), `sparse` = keyword (BM25). A hit can
   * come from one or both. Omitted only by callers that don't compute it.
   */
  signals?: { dense: boolean; sparse: boolean };
  /**
   * Raw per-arm scores, before RRF. `score` above is a fused RANK reciprocal
   * and is not comparable across queries, so it cannot carry a threshold.
   * Duplicate detection needs the dense cosine to decide "close enough to
   * warn". Absent for an arm that did not surface this hit.
   */
  similarity?: { cosine?: number; bm25?: number };
}

/** Stable retrieval capability data returned by status and search tools. */
export interface RetrievalCapabilities {
  mode: 'hybrid' | 'keyword-only';
  semantic: {
    available: boolean;
    reason?: 'optional-embedding-provider-unavailable';
  };
  keyword: {
    available: true;
    source: 'local-project-index';
  };
}

export interface ProjectSearchResponse {
  chunks: SearchHit[];
  capabilities: RetrievalCapabilities;
  fallback: {
    used: boolean;
    kind: 'local-keyword-index';
    hint: string;
  };
}

/** A single fact, parsed from its markdown file + frontmatter. */
export interface Fact {
  /** Path relative to root. */
  sourcePath: string;
  text: string;
  category: string | null;
  scope: string | null;
  /** Higher = more important for start-injection. */
  priority: number;
  /** File mtime epoch millis; recency for contradiction resolution. */
  mtime: number;
}
