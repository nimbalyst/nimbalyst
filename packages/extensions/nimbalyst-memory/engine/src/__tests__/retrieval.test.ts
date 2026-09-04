import { describe, it, expect } from 'vitest';
import { tokenize, termFrequencies, Bm25Index } from '../retrieval/bm25.js';
import { isRankSensitive, maxRankSensitiveK, reciprocalRankFusion } from '../retrieval/rrf.js';
import { cosineSimilarity } from '../retrieval/cosine.js';
import { DEFAULT_FUSION, Retriever } from '../retrieval/retriever.js';
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

  // The defect NIM-5461 fixed. `k` is not a universal constant, it is a
  // constant relative to candidate-pool depth: over a pool of depth D with L
  // equally-weighted lists, an id in every list scores at least L/(k+D) while
  // an id in one list scores at most 1/(k+1). Once L/(k+D) >= 1/(k+1), fusion
  // stops combining ranks and starts counting arm agreement — the top hit of
  // your best arm cannot outrank a chunk both arms ranked last. The shipped
  // retriever had exactly this: k=60 over 50-deep pools, floor 2/110 = 0.01818
  // above ceiling 1/61 = 0.01639, which is why the `claude` source class
  // scored BELOW both of the arms being fused.
  //
  // Property, not a snapshot: it must keep holding if someone retunes k.
  describe('rank sensitivity (a top-of-one-list hit is not buried by consensus)', () => {
    const POOL = 50;

    /** `only` leads list A and is absent from B; `both` is last in both. */
    function poolsWhereOneArmIsConfident(): { a: string[]; b: string[] } {
      const a = ['only', ...Array.from({ length: POOL - 2 }, (_, i) => `filler${i}`), 'both'];
      const b = [...Array.from({ length: POOL - 1 }, (_, i) => `other${i}`), 'both'];
      return { a, b };
    }

    it('at the shipped k, a confident single-arm hit outranks a bottom-of-both hit', () => {
      const { a, b } = poolsWhereOneArmIsConfident();
      const fused = reciprocalRankFusion(
        [
          { ids: a, weight: DEFAULT_FUSION.denseWeight },
          { ids: b, weight: DEFAULT_FUSION.sparseWeight },
        ],
        DEFAULT_FUSION.rrfK
      );
      const rankOf = (id: string) => fused.findIndex((f) => f.id === id);
      expect(rankOf('only')).toBeLessThan(rankOf('both'));
      expect(fused[0].id).toBe('only');
    });

    it('at k=60 over a 50-deep pool it does NOT — the regime being guarded against', () => {
      const { a, b } = poolsWhereOneArmIsConfident();
      const fused = reciprocalRankFusion([{ ids: a }, { ids: b }], 60);
      const rankOf = (id: string) => fused.findIndex((f) => f.id === id);
      // Consensus wins despite `only` leading its list and `both` being last in both.
      expect(rankOf('both')).toBeLessThan(rankOf('only'));
    });

    it('isRankSensitive draws the boundary where the arithmetic does', () => {
      // Equal weights, 2 arms, 50-deep pool: k must be < (50-2)/(2-1) = 48.
      expect(maxRankSensitiveK(POOL, 2)).toBe(47);
      expect(isRankSensitive(47, POOL)).toBe(true);
      expect(isRankSensitive(48, POOL)).toBe(false);
      expect(isRankSensitive(60, POOL)).toBe(false);
      // Weighting one arm up restores headroom that equal weights lack.
      expect(isRankSensitive(60, POOL, [1, 0.2])).toBe(true);
    });

    it('the Retriever refuses to construct a consensus-dominated fusion', () => {
      expect(() => new Retriever([], { rrfK: 60, sparseWeight: 1 })).toThrow(/consensus|rank/i);
      // The harness's explicit opt-out still allows scoring the old config.
      expect(
        () => new Retriever([], { rrfK: 60, sparseWeight: 1, allowRankInsensitive: true })
      ).not.toThrow();
    });
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

  it('keeps A2 page rows out of the chunk arms and out of results', async () => {
    // A page row is a document-level SIGNAL, not an answer. If it leaked into
    // `chunks` it would enter BM25 and cosine, letting the whole first 8 KB of
    // a document compete with its own sections and surface as a headingless
    // hit no caller could cite.
    const chunks = await buildChunks([
      { id: 'a.md#0', sourcePath: 'a.md', ordinal: 0, headingPath: ['Voice'], text: 'voice agent grounding realtime' },
      { id: 'a.md#1', sourcePath: 'a.md', ordinal: 1, headingPath: ['Other'], text: 'unrelated trailing section' },
    ]);
    const page: StoredChunk = {
      ...chunks[0],
      id: 'a.md#page',
      ordinal: -1,
      headingPath: [],
      text: 'voice agent grounding realtime unrelated trailing section',
      granularity: 'page',
      sparseTerms: {},
    };
    const r = new Retriever([...chunks, page]);
    expect(r.size).toBe(2);
    const hits = r.search('voice agent grounding realtime', chunks[0].denseEmbedding, 10);
    expect(hits.every((h) => h.headingPath.length > 0)).toBe(true);
    expect(hits.map((h) => h.citation)).not.toContain('a.md');
  });

  it('resolves a page-arm hit to the best chunk inside that document', async () => {
    // With the page arm enabled, a document whose PAGE matches must still come
    // back as a citable section — the arm ranks documents, fusion needs chunks.
    const chunks = await buildChunks([
      { id: 'a.md#0', sourcePath: 'a.md', ordinal: 0, headingPath: ['Intro'], text: 'introduction boilerplate' },
      { id: 'a.md#1', sourcePath: 'a.md', ordinal: 1, headingPath: ['Voice'], text: 'voice agent grounding realtime tools' },
    ]);
    const embedder = new FakeEmbedder();
    const [pageVec] = await embedder.embed(['introduction boilerplate voice agent grounding realtime tools']);
    const page: StoredChunk = {
      ...chunks[0],
      id: 'a.md#page',
      ordinal: -1,
      headingPath: [],
      text: 'introduction boilerplate voice agent grounding realtime tools',
      granularity: 'page',
      sparseTerms: {},
      denseEmbedding: pageVec,
    };
    const r = new Retriever([...chunks, page], { pageWeight: 1 });
    const [qv] = await embedder.embed(['voice agent grounding realtime tools']);
    const hits = r.search('voice agent grounding realtime tools', qv, 5);
    // The Voice section, not the page row and not the boilerplate intro.
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
