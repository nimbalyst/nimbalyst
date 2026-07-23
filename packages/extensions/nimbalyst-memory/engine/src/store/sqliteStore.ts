/**
 * Rebuildable SQLite shadow index. This is the ONLY persisted state — it can be
 * deleted at any time and reconstructed from the markdown sources. It records
 * the embedder identity (`embedder_id`/`model`/`dims`); switching embedders
 * yields non-comparable vectors, so the caller must `reset()` and re-index.
 *
 * Honors an explicit `nativeBinding` (or the NIMBALYST_BETTER_SQLITE3_NATIVE
 * env) so it loads under both Electron and plain Node (ABI portability),
 * mirroring packages/cli/src/db/openDatabase.ts.
 */
import Database from 'better-sqlite3';
import type { EmbedderInfo, StoredChunk } from '../types.js';

type DB = Database.Database;

function encodeVector(vec: number[] | null): Buffer | null {
  if (!vec?.length) return null;
  return Buffer.from(new Float32Array(vec).buffer);
}

function decodeVector(buf: Buffer | null): number[] | null {
  if (!buf) return null;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  return Array.from(f32);
}

interface ChunkRow {
  id: string;
  source_path: string;
  source_class: string;
  heading_path: string;
  ordinal: number;
  content: string;
  content_hash: string;
  dense_embedding: Buffer | null;
  sparse_terms: string;
  embedder_id: string;
  model: string;
  dims: number;
  updated_at: number;
  ref_type: string;
  ref_id: string;
}

export class SqliteStore {
  private db: DB;

  constructor(dbPath: string, nativeBinding?: string) {
    const binding = nativeBinding || process.env.NIMBALYST_BETTER_SQLITE3_NATIVE || undefined;
    this.db = new Database(dbPath, binding ? { nativeBinding: binding } : {});
    this.db.pragma('journal_mode = WAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        source_class TEXT NOT NULL,
        heading_path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        dense_embedding BLOB,
        sparse_terms TEXT NOT NULL,
        embedder_id TEXT NOT NULL,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ref_type TEXT NOT NULL DEFAULT 'doc-file',
        ref_id TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_path);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.migrate();
  }

  /**
   * Add columns introduced after a store may already exist on disk. The index is
   * rebuildable, so a missing-column store could be wiped instead — but an
   * in-place ALTER avoids a needless full re-embed on upgrade. Existing rows are
   * all file-backed (the only source before virtual records), so they backfill
   * to `ref_type='doc-file'` with `ref_id = source_path`.
   */
  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(chunks)`).all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('ref_type')) {
      this.db.exec(`ALTER TABLE chunks ADD COLUMN ref_type TEXT NOT NULL DEFAULT 'doc-file'`);
    }
    if (!names.has('ref_id')) {
      this.db.exec(`ALTER TABLE chunks ADD COLUMN ref_id TEXT NOT NULL DEFAULT ''`);
      this.db.exec(`UPDATE chunks SET ref_id = source_path WHERE ref_id = ''`);
    }
  }

  // --- Embedder identity ---------------------------------------------------

  getEmbedderInfo(): EmbedderInfo | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'embedder'`).get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as EmbedderInfo;
    } catch {
      return null;
    }
  }

  setEmbedderInfo(info: EmbedderInfo): void {
    this.db
      .prepare(`INSERT INTO meta(key, value) VALUES('embedder', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(info));
  }

  /** Wipe all chunks (used when the embedder changes — vectors are non-comparable). */
  reset(): void {
    this.db.exec(`DELETE FROM chunks;`);
  }

  // --- Dirty-check helpers -------------------------------------------------

  /** Map of chunk id -> content hash for one source file. */
  hashesForSource(sourcePath: string): Map<string, string> {
    const rows = this.db
      .prepare(`SELECT id, content_hash FROM chunks WHERE source_path = ?`)
      .all(sourcePath) as { id: string; content_hash: string }[];
    return new Map(rows.map((r) => [r.id, r.content_hash]));
  }

  /** All indexed source paths (for detecting deleted files). */
  sourcePaths(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT source_path FROM chunks`)
      .all() as { source_path: string }[];
    return rows.map((r) => r.source_path);
  }

  /**
   * Source paths backed by on-disk files only (`ref_type='doc-file'`). The file
   * index pass prunes against THIS list, never against virtual records (trackers,
   * sessions) — those are pruned solely via their own remove path, so a markdown
   * re-index never wipes the catalog.
   */
  fileSourcePaths(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT source_path FROM chunks WHERE ref_type = 'doc-file'`)
      .all() as { source_path: string }[];
    return rows.map((r) => r.source_path);
  }

  // --- Writes --------------------------------------------------------------

  private upsertStmt() {
    return this.db.prepare(`
      INSERT INTO chunks (id, source_path, source_class, heading_path, ordinal,
        content, content_hash, dense_embedding, sparse_terms, embedder_id, model, dims, updated_at,
        ref_type, ref_id)
      VALUES (@id, @source_path, @source_class, @heading_path, @ordinal,
        @content, @content_hash, @dense_embedding, @sparse_terms, @embedder_id, @model, @dims, @updated_at,
        @ref_type, @ref_id)
      ON CONFLICT(id) DO UPDATE SET
        source_path = excluded.source_path,
        source_class = excluded.source_class,
        heading_path = excluded.heading_path,
        ordinal = excluded.ordinal,
        content = excluded.content,
        content_hash = excluded.content_hash,
        dense_embedding = excluded.dense_embedding,
        sparse_terms = excluded.sparse_terms,
        embedder_id = excluded.embedder_id,
        model = excluded.model,
        dims = excluded.dims,
        updated_at = excluded.updated_at,
        ref_type = excluded.ref_type,
        ref_id = excluded.ref_id
    `);
  }

  upsertChunks(chunks: StoredChunk[]): void {
    const stmt = this.upsertStmt();
    const tx = this.db.transaction((items: StoredChunk[]) => {
      for (const c of items) {
        stmt.run({
          id: c.id,
          source_path: c.sourcePath,
          source_class: c.sourceClass,
          heading_path: JSON.stringify(c.headingPath),
          ordinal: c.ordinal,
          content: c.text,
          content_hash: c.contentHash,
          dense_embedding: encodeVector(c.denseEmbedding),
          sparse_terms: JSON.stringify(c.sparseTerms),
          embedder_id: c.embedderId,
          model: c.model,
          dims: c.dims,
          updated_at: c.updatedAt,
          ref_type: c.refType,
          ref_id: c.refId,
        });
      }
    });
    tx(chunks);
  }

  /** Delete chunks of a source whose ids are not in `keepIds` (stale tail). */
  pruneSource(sourcePath: string, keepIds: string[]): void {
    const existing = this.db
      .prepare(`SELECT id FROM chunks WHERE source_path = ?`)
      .all(sourcePath) as { id: string }[];
    const keep = new Set(keepIds);
    const del = this.db.prepare(`DELETE FROM chunks WHERE id = ?`);
    const tx = this.db.transaction(() => {
      for (const r of existing) if (!keep.has(r.id)) del.run(r.id);
    });
    tx();
  }

  deleteSource(sourcePath: string): void {
    this.db.prepare(`DELETE FROM chunks WHERE source_path = ?`).run(sourcePath);
  }

  // --- Reads ---------------------------------------------------------------

  private rowToChunk(r: ChunkRow): StoredChunk {
    return {
      id: r.id,
      sourcePath: r.source_path,
      sourceClass: r.source_class,
      headingPath: JSON.parse(r.heading_path),
      ordinal: r.ordinal,
      text: r.content,
      contentHash: r.content_hash,
      denseEmbedding: decodeVector(r.dense_embedding),
      sparseTerms: JSON.parse(r.sparse_terms),
      embedderId: r.embedder_id,
      model: r.model,
      dims: r.dims,
      updatedAt: r.updated_at,
      refType: r.ref_type,
      refId: r.ref_id,
    };
  }

  /** Load every chunk (the in-memory retrieval set). */
  loadAll(): StoredChunk[] {
    const rows = this.db.prepare(`SELECT * FROM chunks`).all() as ChunkRow[];
    return rows.map((r) => this.rowToChunk(r));
  }

  /** All chunks for one source, ordered, for expand-to-section. */
  chunksForSource(sourcePath: string): StoredChunk[] {
    const rows = this.db
      .prepare(`SELECT * FROM chunks WHERE source_path = ? ORDER BY ordinal`)
      .all(sourcePath) as ChunkRow[];
    return rows.map((r) => this.rowToChunk(r));
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number };
    return row.n;
  }

  /** Count chunks that carry a dense embedding (the dense retrieval arm). */
  countDense(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM chunks WHERE dense_embedding IS NOT NULL`)
      .get() as { n: number };
    return row.n;
  }

  /** Chunk count grouped by source class (for the coverage breakdown). */
  countsBySourceClass(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT source_class AS c, COUNT(*) AS n FROM chunks GROUP BY source_class`)
      .all() as { c: string; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.c] = r.n;
    return out;
  }

  /** Epoch millis of the most recently written chunk, or null when empty. */
  lastUpdatedAt(): number | null {
    const row = this.db.prepare(`SELECT MAX(updated_at) AS t FROM chunks`).get() as {
      t: number | null;
    };
    return row.t ?? null;
  }

  close(): void {
    this.db.close();
  }
}
