/**
 * Item A — dense (semantic) retrieval must actually drive ranking, not just
 * BM25. Uses a deterministic "concept" embedder: texts that share CONCEPTS but
 * no literal tokens get nearby vectors. The query is a paraphrase with zero
 * keyword overlap with the target, so BM25 contributes nothing — only the dense
 * arm + RRF can surface the right chunk. This is the regression guard for the
 * "every hit scores 1/61 because dense never contributes" failure.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryEngine } from '../engine.js';
import type { Embedder, EmbedderInfo, EngineConfig } from '../types.js';

/** Concept groups: a word in any group activates that group's dimension. */
const CONCEPTS: Record<string, string[]> = {
  speed: ['fast', 'quick', 'quickly', 'realtime', 'instant', 'instantly', 'speed', 'latency', 'sub'],
  voice: ['voice', 'speak', 'spoken', 'audio', 'talk', 'conversation', 'conversational'],
  docs: ['docs', 'document', 'documentation', 'design', 'plan', 'plans', 'knowledge', 'reference'],
  cooking: ['bake', 'baking', 'bread', 'sourdough', 'oven', 'dough', 'recipe', 'flour'],
  cars: ['car', 'cars', 'vehicle', 'battery', 'electric', 'engine', 'range', 'charging'],
};
const GROUPS = Object.keys(CONCEPTS);

/** Deterministic concept-space embedder — paraphrases cluster, exact tokens irrelevant. */
class ConceptEmbedder implements Embedder {
  readonly info: EmbedderInfo = { id: 'concept', model: 'concept-test', dims: GROUPS.length };
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const toks = t.toLowerCase().match(/[a-z]+/g) ?? [];
      const v = GROUPS.map((g) => toks.filter((w) => CONCEPTS[g].includes(w)).length);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

const roots: string[] = [];
function setup(): EngineConfig {
  const root = mkdtempSync(path.join(tmpdir(), 'mem-sem-'));
  roots.push(root);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  return {
    root,
    dbPath: path.join(root, 'index.db'),
    factsDir: 'voice-memory',
    sources: [{ sourceClass: 'docs', include: ['docs/**/*.md'] }],
  };
}
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('semantic retrieval (dense arm drives ranking)', () => {
  it('ranks the conceptually-matching chunk first for a zero-keyword-overlap paraphrase', async () => {
    const config = setup();
    // Target: speed + docs concepts, but NONE of the query's literal words.
    writeFileSync(
      path.join(config.root, 'docs/grounding.md'),
      '# Grounding\nThe realtime agent reaches design knowledge instantly.'
    );
    // Distractors in unrelated concept spaces.
    writeFileSync(
      path.join(config.root, 'docs/bread.md'),
      '# Bread\nBake sourdough in the oven with flour.'
    );
    writeFileSync(
      path.join(config.root, 'docs/ev.md'),
      '# EV\nElectric vehicle battery charging range.'
    );

    const engine = MemoryEngine.create(config, new ConceptEmbedder());
    await engine.indexAll();

    // Paraphrase: "fast access to documentation" shares CONCEPTS (speed+docs)
    // with the target but no literal tokens — BM25 alone cannot find it.
    const hits = await engine.search('fast access to documentation', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].sourcePath).toBe('docs/grounding.md');
    await engine.close();
  });

  it('records a query-embed failure in status instead of swallowing it', async () => {
    const config = setup();
    writeFileSync(path.join(config.root, 'docs/x.md'), '# X\nsome content here.');
    const warnings: string[] = [];
    config.onLog = (level, message) => {
      if (level === 'warn') warnings.push(message);
    };
    // Embedder that indexes fine but throws on the (single) query embed.
    let calls = 0;
    const flaky: Embedder = {
      info: { id: 'concept', model: 'concept-test', dims: GROUPS.length },
      async embed(texts: string[]) {
        calls++;
        if (calls > 1) throw new Error('simulated embed outage');
        return new ConceptEmbedder().embed(texts);
      },
    };
    const engine = MemoryEngine.create(config, flaky);
    await engine.indexAll();
    const hits = await engine.search('anything', 3); // still works via sparse
    expect(Array.isArray(hits)).toBe(true);
    expect(engine.status().lastEmbedError).toContain('simulated embed outage');
    expect(warnings.some((w) => w.includes('sparse-only'))).toBe(true);
    await engine.close();
  });
});
