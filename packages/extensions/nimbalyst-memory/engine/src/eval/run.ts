/**
 * The evaluation run: score every planned (arm × embedder slot) column against
 * the golden set and hand back a report.
 *
 * Indexing and embedding happen once per slot, upstream of this module — arms
 * differ only in how they rank a fixed snapshot, so re-indexing per arm would
 * be minutes of wasted work and, worse, would let a chunking difference leak
 * into what is supposed to be a ranking comparison.
 */
import type {
  ArmContext,
  ArmScorecard,
  EmbedderSlot,
  EvalRunReport,
  GoldenQuestion,
  PlannedArm,
} from './types.js';
import {
  buildCorpusIndex,
  buildScorecard,
  scorableQuestions,
  scoreQuestion,
  validateGoldenSet,
} from './scoring.js';

export interface RunOptions {
  /** How many hits each arm is asked for. MRR is computed over this depth. */
  k: number;
  /** The N in recall@N. Must be <= k. */
  recallAt: number;
  /** Optional cap on the number of questions, for quick smoke runs. */
  limit?: number;
  onLog?: (message: string) => void;
}

function emptyScorecard(planned: PlannedArm): ArmScorecard {
  return {
    armId: planned.id,
    armLabel: planned.label,
    slotKey: planned.slot.key,
    declaredOnly: true,
    unavailableReason: planned.slot.unavailableReason ?? 'embedder unavailable',
    buckets: [],
    results: [],
    elapsedMs: 0,
  };
}

/**
 * Score `planned` columns over `questions`.
 *
 * `validationSlot` is the slot whose index defines ground truth — every slot
 * indexes the same files with the same chunker, so the corpus shape is
 * identical and validating once is correct.
 */
export async function runEvaluation(
  planned: PlannedArm[],
  validationSlot: EmbedderSlot,
  questions: GoldenQuestion[],
  opts: RunOptions
): Promise<EvalRunReport> {
  const log = opts.onLog ?? (() => {});
  const corpus = buildCorpusIndex(validationSlot.chunks ?? []);
  const validation = validateGoldenSet(questions, corpus);
  const scorable = scorableQuestions(questions, validation).slice(
    0,
    opts.limit ?? Number.MAX_SAFE_INTEGER
  );

  const scorecards: ArmScorecard[] = [];
  for (const p of planned) {
    const { slot } = p;
    if (!slot.available || !slot.chunks || !slot.embedQuery || !slot.engine) {
      log(`declared (not scored) "${p.id}": ${slot.unavailableReason ?? 'embedder unavailable'}`);
      scorecards.push(emptyScorecard(p));
      continue;
    }
    log(`scoring "${p.id}" over ${scorable.length} question(s)…`);
    const ctx: ArmContext = {
      slot,
      chunks: slot.chunks,
      embedQuery: slot.embedQuery,
      engine: slot.engine,
      hasDense: (slot.info?.dims ?? 0) > 0,
    };
    const arm = await p.spec.build(ctx);
    const started = Date.now();
    const results = [];
    for (const q of scorable) {
      results.push(scoreQuestion(await arm.rank(q.question, opts.k), q));
    }
    scorecards.push(
      buildScorecard(
        p.id,
        p.label,
        slot.key,
        results,
        scorable,
        validation,
        opts.recallAt,
        Date.now() - started
      )
    );
  }

  const status = validationSlot.engine?.status();
  const slots = [...new Set(planned.map((p) => p.slot))].map((s) => ({
    key: s.key,
    label: s.label,
    info: s.info,
    available: s.available,
    ...(s.unavailableReason ? { unavailableReason: s.unavailableReason } : {}),
  }));

  return {
    recallAt: opts.recallAt,
    k: opts.k,
    slots,
    corpus: {
      chunks: status?.chunks ?? 0,
      sourceFiles: status?.sourceFiles ?? 0,
      bySourceClass: status?.bySourceClass ?? {},
    },
    scored: scorable.length,
    validation,
    arms: scorecards,
  };
}
