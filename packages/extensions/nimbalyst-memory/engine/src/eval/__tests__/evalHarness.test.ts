// @vitest-environment node
/**
 * Guards the evaluation harness itself, not the corpus.
 *
 * The scorecard is only worth reading if the scorer is right, and a scorer is
 * exactly the kind of code whose bugs flatter you: ground-truth matching that
 * is accidentally trivially true, or an arm comparison where both columns
 * secretly run the same ranking, both produce plausible-looking numbers.
 *
 * There is deliberately NO assertion on a recall figure from the real corpus.
 * That number is a research result, not an invariant; asserting it would make
 * the suite red every time a doc is edited.
 */
import { describe, it, expect } from 'vitest';
import {
  buildBuckets,
  buildCorpusIndex,
  firstCorrectRank,
  hitMatchesTarget,
  scorableQuestions,
  scoreBucket,
  scoreQuestion,
  validateGoldenSet,
} from '../scoring.js';
import { planArms, selectArms } from '../arms.js';
import { GOLDEN_SET } from '../goldenSet.js';
import type { ArmSpec, EmbedderSlot, GoldenQuestion, QuestionResult, RankedHit } from '../types.js';

const hit = (sourcePath: string, headingPath: string[] = []): RankedHit => ({
  sourcePath,
  headingPath,
});

/** A four-file fixture corpus, small enough to reason about by hand. */
const FIXTURE_CHUNKS = [
  { sourcePath: 'docs/A.md', sourceClass: 'docs', headingPath: ['A', 'Intro'] },
  { sourcePath: 'docs/A.md', sourceClass: 'docs', headingPath: ['A', 'Details'] },
  { sourcePath: 'docs/A.md', sourceClass: 'docs', headingPath: ['A', 'Details', 'Deep'] },
  { sourcePath: 'docs/A.md', sourceClass: 'docs', headingPath: ['A', 'Other'] },
  { sourcePath: 'rules/B.md', sourceClass: 'rules', headingPath: ['B'] },
];
const FIXTURE = buildCorpusIndex(FIXTURE_CHUNKS);

describe('ground-truth matching', () => {
  it('requires the path AND, when given, the heading', () => {
    const target = { path: 'docs/A.md', heading: 'Details' };
    expect(hitMatchesTarget(hit('docs/A.md', ['A', 'Details']), target)).toBe(true);
    // A descendant section still carries the heading in its breadcrumb.
    expect(hitMatchesTarget(hit('docs/A.md', ['A', 'Details', 'Deep']), target)).toBe(true);
    // Right file, wrong section — NOT a match. This is the assertion that stops
    // the whole golden set from degrading into "did we find the right file".
    expect(hitMatchesTarget(hit('docs/A.md', ['A', 'Other']), target)).toBe(false);
    // Right heading text, wrong file.
    expect(hitMatchesTarget(hit('rules/B.md', ['A', 'Details']), target)).toBe(false);
  });

  it('accepts any chunk in the file only when no heading is given', () => {
    expect(hitMatchesTarget(hit('docs/A.md', ['A', 'Other']), { path: 'docs/A.md' })).toBe(true);
    expect(hitMatchesTarget(hit('rules/B.md', ['B']), { path: 'docs/A.md' })).toBe(false);
  });
});

describe('recall@N and MRR', () => {
  const q: GoldenQuestion = {
    id: 'q1',
    question: 'anything',
    expect: [{ path: 'docs/A.md', heading: 'Details' }],
  };

  it('ranks the first correct hit, 1-based', () => {
    const hits = [hit('rules/B.md', ['B']), hit('docs/A.md', ['A', 'Other']), hit('docs/A.md', ['A', 'Details'])];
    expect(firstCorrectRank(hits, q)).toBe(3);
    expect(firstCorrectRank([hit('rules/B.md', ['B'])], q)).toBeNull();
  });

  it('computes a known ranking to a known MRR and recall', () => {
    // Ranks 1, 3, and a miss: recall@5 = 2/3, MRR = (1 + 1/3 + 0)/3.
    const results: QuestionResult[] = [
      { questionId: 'a', rank: 1 },
      { questionId: 'b', rank: 3 },
      { questionId: 'c', rank: null },
    ];
    const bucket = scoreBucket('overall', results, 5);
    expect(bucket.recallAtN).toBeCloseTo(2 / 3, 10);
    expect(bucket.mrr).toBeCloseTo((1 + 1 / 3) / 3, 10);
  });

  it('excludes a correct hit that falls outside recall@N but keeps it in MRR', () => {
    // Rank 7 is a miss at recall@5 and still contributes 1/7 to MRR@10 — the
    // two metrics must not collapse into each other.
    const bucket = scoreBucket('overall', [{ questionId: 'a', rank: 7 }], 5);
    expect(bucket.recallAtN).toBe(0);
    expect(bucket.mrr).toBeCloseTo(1 / 7, 10);
  });

  it('reports the matched hit so a near-miss can be eyeballed', () => {
    const hits = [hit('docs/A.md', ['A', 'Other']), hit('docs/A.md', ['A', 'Details'])];
    const result = scoreQuestion(hits, q);
    expect(result.rank).toBe(2);
    expect(result.matched?.headingPath).toEqual(['A', 'Details']);
    expect(result.top?.headingPath).toEqual(['A', 'Other']);
  });
});

describe('golden-set validation', () => {
  it('flags a target whose file is not indexed, and excludes it from scoring', () => {
    const questions: GoldenQuestion[] = [
      { id: 'ok', question: 'q', expect: [{ path: 'docs/A.md', heading: 'Details' }] },
      { id: 'gone', question: 'q', expect: [{ path: 'docs/DELETED.md', heading: 'Details' }] },
    ];
    const v = validateGoldenSet(questions, FIXTURE);
    expect(v.unresolved).toEqual([
      { questionId: 'gone', target: { path: 'docs/DELETED.md', heading: 'Details' }, reason: 'file-not-indexed' },
    ]);
    // An unscorable question must not be silently averaged in as a zero — that
    // would be indistinguishable from a retrieval failure.
    expect(scorableQuestions(questions, v).map((q) => q.id)).toEqual(['ok']);
  });

  it('flags a heading that no longer exists in a file that does', () => {
    const v = validateGoldenSet(
      [{ id: 'renamed', question: 'q', expect: [{ path: 'docs/A.md', heading: 'Renamed Away' }] }],
      FIXTURE
    );
    expect(v.unresolved[0]?.reason).toBe('heading-not-found');
    expect(v.resolved).toBe(0);
  });

  it('keeps a question scorable when one of several targets resolves', () => {
    const v = validateGoldenSet(
      [
        {
          id: 'multi',
          question: 'q',
          expect: [{ path: 'docs/GONE.md' }, { path: 'rules/B.md', heading: 'B' }],
        },
      ],
      FIXTURE
    );
    expect(v.resolved).toBe(1);
    // The class comes from the first RESOLVABLE target, not blindly from the first.
    expect(v.classByQuestion.multi).toBe('rules');
  });

  it('flags a target that accepts most of its file as coarse', () => {
    const v = validateGoldenSet(
      [
        { id: 'coarse', question: 'q', expect: [{ path: 'docs/A.md', heading: 'A' }] },
        { id: 'fine', question: 'q', expect: [{ path: 'docs/A.md', heading: 'Details' }] },
      ],
      FIXTURE
    );
    expect(v.coarse.map((c) => c.questionId)).toEqual(['coarse']);
    expect(v.coarse[0].coverage).toBe(1);
  });
});

describe('per-bucket breakdown', () => {
  it('derives source classes from the corpus rather than a hardcoded list', () => {
    const questions: GoldenQuestion[] = [
      { id: 'a', question: 'q', expect: [{ path: 'docs/A.md', heading: 'Details' }], tags: ['semantic'] },
      { id: 'b', question: 'q', expect: [{ path: 'rules/B.md', heading: 'B' }] },
    ];
    const v = validateGoldenSet(questions, FIXTURE);
    const buckets = buildBuckets(
      [
        { questionId: 'a', rank: 1 },
        { questionId: 'b', rank: null },
      ],
      questions,
      v,
      5
    );
    expect(buckets.map((b) => b.label)).toEqual(['overall', 'docs', 'rules', 'tag:semantic']);
    // The small class collapsing to zero is exactly what a single aggregate hides.
    expect(buckets.find((b) => b.label === 'overall')!.recallAtN).toBe(0.5);
    expect(buckets.find((b) => b.label === 'docs')!.recallAtN).toBe(1);
    expect(buckets.find((b) => b.label === 'rules')!.recallAtN).toBe(0);
  });
});

describe('arm selection and planning', () => {
  const registry: ArmSpec[] = [
    {
      id: 'sparse',
      label: 'BM25',
      description: '',
      embedderAgnostic: true,
      build: () => ({ rank: async () => [] }),
    },
    {
      id: 'dense',
      label: 'dense',
      description: '',
      requiresDense: true,
      build: () => ({ rank: async () => [] }),
    },
  ];
  const slot = (key: string, dims: number, available: boolean): EmbedderSlot => ({
    key,
    label: key,
    info: available ? { id: key, model: key, dims } : null,
    available,
    ...(available ? {} : { unavailableReason: 'not installed' }),
  });

  it('reports an unknown arm id rather than silently dropping it', () => {
    const { specs, unknown } = selectArms(['sparse', 'pagevec'], registry);
    expect(specs.map((s) => s.id)).toEqual(['sparse']);
    expect(unknown).toEqual(['pagevec']);
  });

  it('scores an embedder-agnostic arm once, not once per slot', () => {
    // BM25 reads the same sparse terms on every slot; three identical columns
    // would just pad the table.
    const slots = [slot('sparse', 0, true), slot('openai', 1536, true)];
    const planned = planArms(registry, slots);
    expect(planned.filter((p) => p.spec.id === 'sparse').map((p) => p.slot.key)).toEqual(['sparse']);
  });

  it('declares a dense arm on an unavailable slot instead of omitting it', () => {
    // The whole point: "never measured" must not read as "measured and bad".
    const slots = [slot('sparse', 0, true), slot('local', 0, false)];
    const planned = planArms(registry, slots);
    const dense = planned.filter((p) => p.spec.id === 'dense');
    expect(dense.map((p) => p.slot.key)).toEqual(['local']);
    expect(dense[0].slot.available).toBe(false);
  });

  it('does not put a dense arm on a keyword-only slot', () => {
    const planned = planArms(registry, [slot('sparse', 0, true)]);
    expect(planned.map((p) => p.id)).toEqual(['sparse@sparse']);
  });

  it('qualifies column labels by slot only when the run spans slots', () => {
    const single = planArms(registry, [slot('sparse', 0, true)]);
    expect(single[0].label).toBe('BM25');
    const multi = planArms(registry, [slot('sparse', 0, true), slot('openai', 1536, true)]);
    expect(multi.map((p) => p.label)).toEqual(['BM25·sparse', 'dense·openai']);
  });
});

describe('the golden set itself', () => {
  it('has unique ids and at least one target each', () => {
    const ids = GOLDEN_SET.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of GOLDEN_SET) expect(q.expect.length).toBeGreaterThan(0);
  });

  it('is large enough and carries enough semantic questions to discriminate arms', () => {
    // The plan calls for 30-50 questions. A set of purely lexical questions
    // would score every arm the same and measure nothing, so the semantic share
    // is a property of the data, not a hope.
    expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(30);
    const semantic = GOLDEN_SET.filter((q) => q.tags?.includes('semantic'));
    expect(semantic.length / GOLDEN_SET.length).toBeGreaterThan(0.3);
  });
});
