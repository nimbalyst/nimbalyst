import { describe, it, expect } from 'vitest';
import { tokenize, termFrequencies, Bm25Index } from '../retrieval/bm25.js';
import { reciprocalRankFusion } from '../retrieval/rrf.js';
import { cosineSimilarity } from '../retrieval/cosine.js';
import { Retriever } from '../retrieval/retriever.js';
import { FakeEmbedder } from './fakeEmbedder.js';
import type { StoredChunk } from '../types.js';

describe('tokenize', () => {
  it('keeps dotted/slashed identifiers intact', () => {
    expect(tokenize('open VoiceModeService.ts in src/main')).toContain('voicemodeservice.ts');
    expect(tokenize('open VoiceModeService.ts in src/main')).toContain('src/main');
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical and ~0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
});

describe('Bm25Index', () => {
  it('ranks the doc that contains the rare query term highest', () => {
    const docs = [
      { id: 'a', tf: termFrequencies('the quick brown fox') },
      { id: 'b', tf: termFrequencies('reciprocal rank fusion algorithm') },
      { id: 'c', tf: termFrequencies('lazy dog sleeps') },
    ];
    const ranked = new Bm25Index(docs).search('fusion');
    expect(ranked[0].id).toBe('b');
  });

  it('survives Object.prototype-colliding tokens ("constructor", "toString")', () => {
    // Regression: a plain-object term map makes `tf["constructor"] ?? 0`
    // return the Object constructor function, so `+ 1` builds a STRING; that
    // poisons one doc-length, turns avgdl into NaN, and silently kills BM25
    // for EVERY query. "constructor"/"toString" are common in code docs.
    const tf = termFrequencies('the class constructor calls toString on the constructor');
    // Counts must be numbers, never the corrupted "function Object(){...}1" string.
    expect(typeof tf['constructor']).toBe('number');
    expect(tf['constructor']).toBe(2);
    expect(typeof tf['tostring']).toBe('number');

    const docs = [
      { id: 'a', tf: termFrequencies('the class constructor calls toString here') },
      { id: 'b', tf: termFrequencies('reciprocal rank fusion algorithm') },
      { id: 'c', tf: termFrequencies('lazy dog sleeps quietly') },
    ];
    const idx = new Bm25Index(docs);
    // A normal query must still return results (avgdl finite, not NaN).
    expect(idx.search('fusion')[0]?.id).toBe('b');
    // And a query for the colliding token finds the right doc.
    expect(idx.search('constructor')[0]?.id).toBe('a');
  });
});

describe('reciprocalRankFusion', () => {
  it('rewards ids ranked highly across multiple lists', () => {
    const fused = reciprocalRankFusion([
      { ids: ['x', 'y', 'z'] },
      { ids: ['y', 'x', 'w'] },
    ]);
    // y is rank 2 then 1; x is rank 1 then 2 — both beat single-list ids.
    expect(fused[0].id === 'x' || fused[0].id === 'y').toBe(true);
    expect(fused.slice(0, 2).map((f) => f.id).sort()).toEqual(['x', 'y']);
  });
});

async function buildChunks(
  rows: { id: string; sourcePath: string; ordinal: number; headingPath: string[]; text: string }[]
): Promise<StoredChunk[]> {
  const embedder = new FakeEmbedder();
  const vectors = await embedder.embed(rows.map((r) => r.text));
  return rows.map((r, i) => ({
    id: r.id,
    sourcePath: r.sourcePath,
    sourceClass: 'docs',
    headingPath: r.headingPath,
    ordinal: r.ordinal,
    text: r.text,
    contentHash: `h-${r.id}`,
    denseEmbedding: vectors[i],
    sparseTerms: termFrequencies(r.text),
    embedderId: embedder.info.id,
    model: embedder.info.model,
    dims: embedder.info.dims,
    updatedAt: 1,
    refType: 'doc-file',
    refId: r.sourcePath,
  }));
}

describe('Retriever (hybrid + expand)', () => {
  it('finds the relevant chunk by hybrid search', async () => {
    const chunks = await buildChunks([
      { id: 'a#0', sourcePath: 'a.md', ordinal: 0, headingPath: ['Voice'], text: 'voice agent grounding with realtime tools' },
      { id: 'b#0', sourcePath: 'b.md', ordinal: 0, headingPath: ['Cooking'], text: 'how to bake sourdough bread' },
      { id: 'c#0', sourcePath: 'c.md', ordinal: 0, headingPath: ['Cars'], text: 'electric vehicle battery range' },
    ]);
    const r = new Retriever(chunks);
    const embedder = new FakeEmbedder();
    const [qv] = await embedder.embed(['realtime voice agent tools']);
    const hits = r.search('realtime voice agent tools', qv, 3);
    expect(hits[0].sourcePath).toBe('a.md');
    expect(hits[0].citation).toBe('a.md#Voice');
  });

  it('expands a hit to its full heading section', async () => {
    const chunks = await buildChunks([
      { id: 'd.md#0', sourcePath: 'd.md', ordinal: 0, headingPath: ['Alpha'], text: 'alpha part one' },
      { id: 'd.md#1', sourcePath: 'd.md', ordinal: 1, headingPath: ['Alpha'], text: 'alpha part two' },
      { id: 'd.md#2', sourcePath: 'd.md', ordinal: 2, headingPath: ['Beta'], text: 'beta content' },
    ]);
    const r = new Retriever(chunks);
    const section = r.expandSection('d.md', ['Alpha']);
    expect(section?.text).toBe('alpha part one\n\nalpha part two');
  });

  it('runs sparse-only when no query vector is supplied', async () => {
    const chunks = await buildChunks([
      { id: 'a#0', sourcePath: 'a.md', ordinal: 0, headingPath: ['H'], text: 'unique_symbol_xyz lives here' },
      { id: 'b#0', sourcePath: 'b.md', ordinal: 0, headingPath: ['H'], text: 'nothing relevant' },
    ]);
    const r = new Retriever(chunks);
    const hits = r.search('unique_symbol_xyz', null, 2);
    expect(hits[0].sourcePath).toBe('a.md');
  });

  it('restricts retrieval to the requested source class', async () => {
    // Models the real bug: many doc/plan chunks match a topic and crowd the
    // (capped) candidate pool, so a relevant session never surfaces in a global
    // search. Scoping to ['sessions'] must return ONLY session entities.
    const embedder = new FakeEmbedder();
    const rows = [
      { id: 'd1#0', sourceClass: 'docs', refType: 'doc-file', refId: 'd1.md', text: 'collaborative document realtime sync design' },
      { id: 'd2#0', sourceClass: 'docs', refType: 'doc-file', refId: 'd2.md', text: 'collaborative document realtime sync notes' },
      { id: 'p1#0', sourceClass: 'plans', refType: 'plan', refId: 'p1.md', text: 'collaborative document realtime sync plan' },
      { id: 's1#0', sourceClass: 'sessions', refType: 'session', refId: 'sess-abc', text: 'worked on the collaborative document realtime sync feature' },
    ];
    const vectors = await embedder.embed(rows.map((r) => r.text));
    const chunks: StoredChunk[] = rows.map((r, i) => ({
      id: r.id,
      sourcePath: r.refId,
      sourceClass: r.sourceClass,
      headingPath: [],
      ordinal: 0,
      text: r.text,
      contentHash: `h-${r.id}`,
      denseEmbedding: vectors[i],
      sparseTerms: termFrequencies(r.text),
      embedderId: embedder.info.id,
      model: embedder.info.model,
      dims: embedder.info.dims,
      updatedAt: 1,
      refType: r.refType,
      refId: r.refId,
    }));
    const retriever = new Retriever(chunks);
    const [qv] = await embedder.embed(['collaborative document system']);

    // Unscoped: docs/plans are present (they dominate the pool).
    const global = retriever.search('collaborative document system', qv, 10);
    expect(global.some((h) => h.sourceClass === 'docs')).toBe(true);

    // Scoped: only the session entity comes back.
    const scoped = retriever.search('collaborative document system', qv, 10, {
      sourceClasses: ['sessions'],
    });
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((h) => h.sourceClass === 'sessions')).toBe(true);
    expect(scoped.map((h) => h.refId)).toContain('sess-abc');
  });
});
