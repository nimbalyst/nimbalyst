#!/usr/bin/env node
/**
 * `npm run memory:eval` — index this repo's real corpus and print a
 * recall@N / MRR scorecard, one column per (retrieval arm × embedding model).
 *
 * This is a script, not a vitest test, on purpose. Indexing ~20k chunks takes
 * minutes on a cold index; a test that slow gets deleted (see the testing rule
 * in CLAUDE.md), and a threshold asserted against a live corpus is a flaky
 * number nobody can act on. The harness *itself* is unit-tested against a tiny
 * fixture in `__tests__/`; the corpus numbers live here, in output a human
 * reads.
 *
 * Indexes are cached per (root, embedder identity) under `--cache-dir`, so
 * re-running after adding an arm costs no embedding calls.
 *
 * Usage:
 *   npm run memory:eval                            # keyless BM25 baseline
 *   npm run memory:eval -- --embedders=sparse,openai,local
 *   npm run memory:eval -- --per-question
 *
 * Flags:
 *   --embedders=a,b   slots to declare (default: sparse,openai,local)
 *   --arms=a,b        arms to score  (default: sparse,dense,rrf)
 *   --k=N             hits requested per query (default: 10)
 *   --recall-at=N     the N in recall@N (default: 5)
 *   --limit=N         score only the first N questions (smoke runs)
 *   --root=PATH       corpus root (default: nearest ancestor with a .git)
 *   --cache-dir=PATH  where per-embedder indexes live (default: <root>/nimbalyst-local/memory-eval)
 *   --key-file=PATH   JSON settings file holding the embedding key
 *                     (default: the desktop app's ai-settings.json)
 *   --key-field=A.B   dotted field within it (default: apiKeys.openai)
 *   --reindex         wipe the cached indexes and rebuild
 *   --per-question    also print the per-question rank table
 *   --json            emit the raw report as JSON instead of the scorecard
 *   --strict          exit non-zero if any golden target is unresolvable
 *
 * The key is read from the settings file, never from `process.env` — see the
 * header of `keySource.ts` for why that is not a stylistic preference.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_ARMS, planArms, selectArms } from './arms.js';
import { findRepoRoot } from './corpus.js';
import { GOLDEN_SET } from './goldenSet.js';
import { DEFAULT_KEY_FIELD, resolveApiKey } from './keySource.js';
import { formatCorpus, formatPerQuestion, formatScorecard, formatValidation } from './report.js';
import { runEvaluation } from './run.js';
import { buildSlots, closeSlots, type SlotRequest } from './slots.js';

const DEFAULT_EMBEDDERS = ['sparse', 'openai', 'local'];

interface Flags {
  embedders: string[];
  arms: string[] | null;
  k: number;
  recallAt: number;
  limit?: number;
  root?: string;
  cacheDir?: string;
  keyFile?: string;
  keyField: string;
  reindex: boolean;
  perQuestion: boolean;
  json: boolean;
  strict: boolean;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
  };
  const list = (name: string): string[] | null => {
    const raw = get(name);
    if (!raw) return null;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  };
  const has = (name: string) => argv.includes(`--${name}`);
  const limit = get('limit');
  return {
    embedders: list('embedders') ?? DEFAULT_EMBEDDERS,
    arms: list('arms'),
    k: Number(get('k') || 10),
    recallAt: Number(get('recall-at') || 5),
    limit: limit ? Number(limit) : undefined,
    root: get('root') || undefined,
    cacheDir: get('cache-dir') || undefined,
    keyFile: get('key-file') || undefined,
    keyField: get('key-field') || DEFAULT_KEY_FIELD,
    reindex: has('reindex'),
    perQuestion: has('per-question'),
    json: has('json'),
    strict: has('strict'),
  };
}

/**
 * Turn requested embedder names into slot requests. A backend the machine
 * cannot provide becomes a declared-unavailable request rather than an error:
 * the point is that the scorecard shows a column for it with the reason, so
 * "never measured" never reads as "measured and bad".
 */
function slotRequests(flags: Flags, log: (m: string) => void): SlotRequest[] {
  return flags.embedders.map((name): SlotRequest => {
    if (name === 'sparse') {
      return { key: 'sparse', label: 'keyword-only (BM25)', config: { kind: 'sparse' } };
    }
    if (name === 'openai') {
      const lookup = resolveApiKey(flags.keyFile, flags.keyField);
      if (!lookup.key) {
        return {
          key: 'openai',
          label: 'openai embeddings',
          config: null,
          unavailableReason: `no API key in settings: ${lookup.detail}`,
        };
      }
      log(`openai key resolved from ${lookup.detail}`);
      return {
        key: 'openai',
        label: 'openai embeddings',
        config: { kind: 'openai', apiKey: lookup.key },
      };
    }
    if (name === 'local') {
      // Phase 2 wires the ONNX embedder and installs @huggingface/transformers.
      // Until then this resolves to an unavailable slot whose column is printed
      // as "not measured", which is the honest state.
      return {
        key: 'local',
        label: 'local ONNX embeddings',
        config: { kind: 'local', model: process.env.NIMBALYST_MEMORY_LOCAL_MODEL },
        unavailableReason: 'local ONNX embedder not installed (phase 2)',
      };
    }
    return { key: name, label: name, config: null, unavailableReason: `unknown embedder "${name}"` };
  });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.recallAt > flags.k) {
    throw new Error(`--recall-at=${flags.recallAt} exceeds --k=${flags.k}`);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(flags.root || findRepoRoot(here));
  const log = (msg: string) => process.stderr.write(`[memory-eval] ${msg}\n`);
  // Default cache lives in the gitignored local working dir rather than a tmp
  // path the OS may reap, because losing it means re-spending on embeddings.
  const cacheDir = path.resolve(flags.cacheDir || path.join(root, 'nimbalyst-local', 'memory-eval'));

  log(`root=${root}`);
  log(`cache=${cacheDir}`);

  const slots = await buildSlots(slotRequests(flags, log), {
    root,
    cacheDir,
    nativeBinding: process.env.NIMBALYST_BETTER_SQLITE3_NATIVE || undefined,
    reindex: flags.reindex,
    log,
  });

  try {
    const { specs, unknown } = selectArms(flags.arms, BUILT_IN_ARMS);
    for (const id of unknown) {
      log(`unknown arm "${id}" (known: ${BUILT_IN_ARMS.map((a) => a.id).join(', ')})`);
    }
    const planned = planArms(specs, slots);
    if (planned.length === 0) throw new Error('no arms to run');

    // Ground truth is validated against an available slot's index; every slot
    // chunks the same files identically, so any of them describes the corpus.
    const validationSlot = slots.find((s) => s.available);
    if (!validationSlot) throw new Error('no embedder slot could be built; nothing to index');

    const report = await runEvaluation(planned, validationSlot, GOLDEN_SET, {
      k: flags.k,
      recallAt: flags.recallAt,
      limit: flags.limit,
      onLog: log,
    });

    if (flags.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      const out: string[] = ['', formatCorpus(report), ''];
      const validation = formatValidation(report);
      if (validation) out.push(validation);
      out.push(`arms (${report.scored} questions scored of ${report.validation.total}):`);
      for (const spec of specs) out.push(`  ${spec.id.padEnd(8)} ${spec.description}`);
      out.push('');
      out.push(formatScorecard(report));
      if (flags.perQuestion) {
        out.push('');
        out.push(formatPerQuestion(report, GOLDEN_SET));
      }
      process.stdout.write(out.join('\n'));
    }

    if (flags.strict && report.validation.unresolved.length > 0) {
      log(`strict: ${report.validation.unresolved.length} unresolvable golden target(s)`);
      process.exitCode = 1;
    }
  } finally {
    await closeSlots(slots);
  }
}

main().catch((err) => {
  process.stderr.write(`[memory-eval] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
