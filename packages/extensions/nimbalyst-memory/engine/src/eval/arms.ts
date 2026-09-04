/**
 * The arm registry — the harness's extension point.
 *
 * An arm is one retrieval configuration to score. The runner iterates this
 * array and knows nothing about what any entry does, so adding an arm is data:
 * append an `ArmSpec`. In particular the page-level-vector variant from
 * amendment A2 of the memory-v3 plan lands here as one more entry, alongside
 * the chunk-level arms it is meant to be compared against — nothing in
 * `run.ts`, `scoring.ts`, or `report.ts` changes.
 *
 * The three built-ins deliberately decompose the shipped retriever: `sparse`
 * and `dense` are its two arms in isolation, `rrf` is the fusion actually
 * served. Comparing all three is what tells you whether fusion is earning its
 * keep or whether one arm is carrying the other.
 */
import { Retriever, type FusionConfig } from '../retrieval/retriever.js';
import { cosineSimilarity } from '../retrieval/cosine.js';
import type { ArmContext, ArmSpec, EmbedderSlot, EvalArm, PlannedArm, RankedHit } from './types.js';

/** Wrap a `Retriever` so it satisfies `EvalArm`, with a fixed query vector mode. */
function retrieverArm(
  ctx: ArmContext,
  useDense: boolean,
  fusion?: Partial<FusionConfig>
): EvalArm {
  const retriever = new Retriever(ctx.chunks, fusion);
  return {
    async rank(query, k) {
      const vec = useDense ? await ctx.embedQuery(query) : null;
      return retriever.search(query, vec, k).map((h) => ({
        sourcePath: h.sourcePath,
        headingPath: h.headingPath,
        score: h.score,
      }));
    },
  };
}

export const BUILT_IN_ARMS: ArmSpec[] = [
  {
    id: 'sparse',
    label: 'BM25',
    description: 'Keyword only. What a keyless install gets today (the `sparse` embedder).',
    // BM25 reads `sparseTerms`, which the chunker produces identically whatever
    // embedder is configured — scoring it once per slot would print the same
    // column N times.
    embedderAgnostic: true,
    build: (ctx) => retrieverArm(ctx, false),
  },
  {
    id: 'dense',
    label: 'dense',
    description: 'Embedding cosine only, no keyword arm. Isolates what semantics buys.',
    requiresDense: true,
    build: (ctx) => {
      // Cosine ranking over the same snapshot the retriever uses. Chunks with
      // no vector are skipped rather than scored as 0 — an unembedded chunk is
      // absent from this arm, not maximally dissimilar.
      //
      // Page rows (A2) are excluded: they are a separate arm, and leaving them
      // in would let a headingless whole-document row displace real chunks in
      // the chunk-level baseline — quietly depressing the very column the page
      // arm is supposed to be compared against.
      const embedded = ctx.chunks.filter(
        (c) => c.granularity !== 'page' && c.denseEmbedding && c.denseEmbedding.length
      );
      return {
        async rank(query, k) {
          const vec = await ctx.embedQuery(query);
          if (!vec || !vec.length) return [];
          const scored: RankedHit[] = embedded.map((c) => ({
            sourcePath: c.sourcePath,
            headingPath: c.headingPath,
            score: cosineSimilarity(vec, c.denseEmbedding!),
          }));
          scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
          return scored.slice(0, k);
        },
      };
    },
  },
  {
    id: 'rrf',
    label: 'RRF hybrid',
    description: 'The shipped retriever: dense + BM25 fused with reciprocal rank fusion.',
    requiresDense: true,
    build: (ctx) => retrieverArm(ctx, true),
  },
  ...fusionSweepArms(),
  ...pageVectorArms(),
];

/**
 * Amendment A2: the page-level vector as a THIRD arm.
 *
 * Each source's first 8 KB is embedded as one row beside its chunks
 * (`granularity: 'page'` — see `indexer.ts`), ranked by cosine, and resolved to
 * the best chunk inside the winning document before fusion, so it competes on
 * the same citable units as the other arms.
 *
 * `page-only` isolates what a whole-document vector can do alone; the weighted
 * variants ask whether adding it to the tuned two-arm fusion buys anything. A2
 * is explicit that this is settled by these numbers and not by argument, in
 * either direction.
 */
function pageVectorArms(): ArmSpec[] {
  const specs: ArmSpec[] = [
    {
      id: 'page-only',
      label: 'page-only',
      description: 'A2: whole-document vectors alone, resolved to their best chunk.',
      requiresDense: true,
      build: (ctx: ArmContext) =>
        retrieverArm(ctx, true, {
          denseWeight: 0,
          sparseWeight: 0,
          pageWeight: 1,
          allowRankInsensitive: true,
        }),
    },
  ];
  for (const pageWeight of [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1]) {
    specs.push({
      id: `rrf-page${pageWeight}`,
      label: `+page w=${pageWeight}`,
      description: `A2: tuned two-arm fusion plus the page arm at weight ${pageWeight}.`,
      requiresDense: true,
      build: (ctx: ArmContext) => retrieverArm(ctx, true, { pageWeight }),
    });
  }
  return specs;
}

/**
 * Fusion-parameter sweep arms.
 *
 * `k` and the arm weights are the two knobs that decide whether RRF combines
 * ranks or merely counts arm agreement (see `rrf.ts`). Both defaults are
 * supposed to be measurements, so the sweep that produced them stays runnable:
 * `--arms=rrf-k60-w1,rrf-k8-w1,rrf-k8-w0.5` reproduces the comparison that
 * picked them, and `rrf-k60-w1` is the pre-fix configuration kept as a
 * regression reference.
 */
function fusionSweepArms(): ArmSpec[] {
  const combos: Array<{ k: number; sparseWeight: number; note: string }> = [
    { k: 60, sparseWeight: 1, note: 'the pre-fix shipped config: consensus-dominated' },
    { k: 30, sparseWeight: 1, note: 'k halved, equal weights' },
    { k: 15, sparseWeight: 1, note: 'k=15, equal weights' },
    { k: 8, sparseWeight: 1, note: 'k=8, equal weights — isolates k from weighting' },
    { k: 4, sparseWeight: 1, note: 'k=4, equal weights' },
    { k: 15, sparseWeight: 0.7, note: 'k=15, sparse at 0.7' },
    { k: 15, sparseWeight: 0.5, note: 'k=15, sparse at half weight' },
    { k: 15, sparseWeight: 0.3, note: 'k=15, sparse at 0.3' },
    { k: 8, sparseWeight: 0.5, note: 'k=8, sparse at half weight' },
    { k: 4, sparseWeight: 0.7, note: 'k=4, sparse at 0.7' },
    { k: 4, sparseWeight: 0.5, note: 'k=4, sparse at half weight' },
    { k: 4, sparseWeight: 0.3, note: 'k=4, sparse at 0.3' },
  ];
  return combos.map(({ k, sparseWeight, note }) => ({
    id: `rrf-k${k}-w${sparseWeight}`,
    label: `RRF k=${k} w=${sparseWeight}`,
    description: `Fusion sweep: ${note}.`,
    requiresDense: true,
    build: (ctx: ArmContext) =>
      retrieverArm(ctx, true, {
        rrfK: k,
        denseWeight: 1,
        sparseWeight,
        // The sweep deliberately includes configurations the shipped guard
        // rejects — scoring them is the point.
        allowRankInsensitive: true,
      }),
  }));
}

/**
 * Select arms by id from the registry, reporting anything unknown rather than
 * dropping it silently — a misspelled `--arms=` entry that just vanishes would
 * produce a scorecard missing the column you came to read.
 */
export function selectArms(
  requested: string[] | null,
  registry: ArmSpec[] = BUILT_IN_ARMS
): { specs: ArmSpec[]; unknown: string[] } {
  const byId = new Map(registry.map((a) => [a.id, a]));
  const wanted = requested ?? registry.map((a) => a.id);
  const specs: ArmSpec[] = [];
  const unknown: string[] = [];
  for (const id of wanted) {
    const spec = byId.get(id);
    if (spec) specs.push(spec);
    else unknown.push(id);
  }
  return { specs, unknown };
}

/**
 * Cross arms with embedder slots to produce the scorecard's columns.
 *
 * A dense-requiring arm is expanded onto every dense-capable slot INCLUDING
 * unavailable ones, so a model nobody has installed yet shows up as a declared
 * column with a reason instead of being absent. That is what lets a later slice
 * fill in the local-embedder numbers without touching this file.
 */
export function planArms(specs: ArmSpec[], slots: EmbedderSlot[]): PlannedArm[] {
  const denseSlots = slots.filter((s) => !s.info || s.info.dims > 0);
  const firstAvailable = slots.find((s) => s.available) ?? slots[0];
  const multi = new Set<string>();
  const planned: PlannedArm[] = [];

  for (const spec of specs) {
    const targets = spec.embedderAgnostic
      ? firstAvailable
        ? [firstAvailable]
        : []
      : spec.requiresDense
        ? denseSlots
        : slots;
    for (const slot of targets) {
      planned.push({ id: `${spec.id}@${slot.key}`, label: spec.label, spec, slot });
      multi.add(slot.key);
    }
  }
  // Only qualify labels when the run actually spans slots; a single-slot run
  // reads better as `BM25` than `BM25·sparse`.
  if (multi.size > 1) {
    for (const p of planned) p.label = `${p.spec.label}·${p.slot.key}`;
  }
  return planned;
}
