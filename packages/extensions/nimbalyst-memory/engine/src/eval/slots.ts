/**
 * Building embedder slots: one index per embedding backend, cached on disk.
 *
 * The cache is load-bearing, not an optimisation. A measurement instrument that
 * costs money and minutes every time it runs does not get run, and every later
 * retrieval change is supposed to be gated on re-running this. Indexes are
 * keyed by (root, embedder identity) and the engine's own content-hash dirty
 * check means a re-run after editing three docs re-embeds three docs.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { MemoryEngine } from "../engine.js";
import { createEmbedder, type EmbedderConfig } from "../embedders/factory.js";
import { SqliteStore } from "../store/sqliteStore.js";
import type { EngineConfig } from "../types.js";
import { EVAL_EXCLUDE, EVAL_FACTS_DIR, evalSources } from "./corpus.js";
import type { EmbedderSlot } from "./types.js";

/** A slot the run wants, before it is known whether the machine can provide it. */
export interface SlotRequest {
  key: string;
  label: string;
  /** Null when the backend is known-unavailable (no key, model not installed). */
  config: EmbedderConfig | null;
  unavailableReason?: string;
}

export interface BuildSlotsOptions {
  root: string;
  /** Directory holding the cached per-embedder indexes. */
  cacheDir: string;
  nativeBinding?: string;
  reindex?: boolean;
  log?: (message: string) => void;
}

function dbPathFor(cacheDir: string, root: string, identity: string): string {
  const key = createHash("sha256")
    .update(`${root}\u0000${identity}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(cacheDir, `${key}.db`);
}

/**
 * Construct every requested slot, indexing the corpus once per available
 * backend. A request with no config (or one whose embedder fails to load) comes
 * back declared-but-unavailable rather than throwing, so one missing model does
 * not cost you the columns you could have measured.
 */
export async function buildSlots(
  requests: SlotRequest[],
  opts: BuildSlotsOptions
): Promise<EmbedderSlot[]> {
  const log = opts.log ?? (() => {});
  mkdirSync(opts.cacheDir, { recursive: true });
  const slots: EmbedderSlot[] = [];

  for (const req of requests) {
    if (!req.config) {
      slots.push({
        key: req.key,
        label: req.label,
        info: null,
        available: false,
        unavailableReason: req.unavailableReason ?? "not configured",
      });
      continue;
    }
    try {
      const embedder = await createEmbedder(req.config);
      const info = embedder.info;
      const identity = `${info.id}:${info.model}:${info.dims}`;
      const dbPath = dbPathFor(opts.cacheDir, opts.root, identity);
      if (opts.reindex) {
        for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
          rmSync(p, { force: true });
      }

      const config: EngineConfig = {
        root: opts.root,
        dbPath,
        factsDir: EVAL_FACTS_DIR,
        sources: evalSources(),
        exclude: EVAL_EXCLUDE,
        nativeBinding: opts.nativeBinding,
        onLog: (level, message) => {
          if (level === "warn" || level === "error")
            log(`[${req.key}] ${level}: ${message}`);
        },
      };

      log(
        `slot "${req.key}": ${info.id}/${info.model} (${info.dims}d) index=${dbPath}`
      );
      const engine = MemoryEngine.create(config, embedder);
      let lastPct = -1;
      const result = await engine.indexAll((p) => {
        if (p.phase !== "index" || p.total <= 0) return;
        const done = Math.floor((p.done / p.total) * 100);
        if (done >= lastPct + 10) {
          lastPct = done;
          log(`  [${req.key}] indexing ${p.done}/${p.total}`);
        }
      });
      log(
        `  [${req.key}] ${result.indexed} chunk(s) written across ${result.files} file(s)`
      );

      // Read the snapshot straight from the store so every arm on this slot
      // ranks over provably identical input.
      const store = new SqliteStore(dbPath, opts.nativeBinding);
      const chunks = store.loadAll();
      store.close();

      const cache = new Map<string, number[] | null>();
      slots.push({
        key: req.key,
        label: req.label,
        info,
        available: true,
        chunks,
        engine,
        // Memoized because every arm on this slot asks for the same vectors:
        // one API call per question, not one per question per arm.
        async embedQuery(text) {
          if (cache.has(text)) return cache.get(text)!;
          if (info.dims === 0) {
            cache.set(text, null);
            return null;
          }
          const [vec] = await embedder.embed([text]);
          const value = vec && vec.length ? vec : null;
          cache.set(text, value);
          return value;
        },
      });
    } catch (err) {
      // One backend failing to load must not cost the columns that did load.
      slots.push({
        key: req.key,
        label: req.label,
        info: null,
        available: false,
        unavailableReason: (err as Error)?.message ?? String(err),
      });
      log(`slot "${req.key}" unavailable: ${(err as Error)?.message ?? err}`);
    }
  }
  return slots;
}

export async function closeSlots(slots: EmbedderSlot[]): Promise<void> {
  for (const s of slots) await s.engine?.close();
}
