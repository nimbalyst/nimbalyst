/**
 * The candidate registry for local (ONNX / transformers.js) embedding models.
 *
 * This exists so "which model" is a data question with a measurable answer
 * rather than a constant buried in the embedder. Every entry is scored against
 * the golden set by the eval harness — `NIMBALYST_MEMORY_LOCAL_MODEL=<repo>@<dtype>
 * npm run memory:eval -- --embedders=local --arms=dense` — and the default below
 * is whichever entry those numbers picked. Compare on the `dense` arm: it
 * isolates the embedder, where `rrf` also moves whenever fusion is retuned.
 *
 * Two fields drive the decision and neither is a preference:
 *
 * - `downloadBytes` is what the user is asked to accept on first run. The plan
 *   names a multi-hundred-megabyte first run as a risk in its own right, so a
 *   model must beat the keyword baseline by enough to justify its own size, not
 *   merely beat it.
 * - `dims` drives index size for every chunk forever. The OpenAI 1536-dim index
 *   is 351 MB for this repo; a 384-dim model is a quarter of that.
 *
 * Sizes are MEASURED from the bytes that actually land in the cache after a
 * cold load at the listed `dtype`, not read off a model card — a repo carries
 * several weight variants and only the selected one is fetched.
 *
 * ## Why the default is instruction-free
 *
 * Retrieval-tuned models split into two families: ones that embed a query and a
 * passage identically, and ones that require asymmetric prefixes (nomic's
 * `search_query:` / `search_document:`, E5's `query:` / `passage:`). The
 * `Embedder` contract is a single `embed(texts)` with no query/passage
 * distinction, so an asymmetric model cannot be driven correctly from here —
 * it would be measured, and shipped, in the configuration its authors warn
 * against. Such a model stays in the registry with `asymmetric: true` so the
 * harness can still score it honestly-labelled, but it cannot be the default
 * until the contract can express the distinction.
 */

export type LocalModelDtype = 'fp32' | 'fp16' | 'q8' | 'q4';

/**
 * How token vectors are collapsed into one sentence vector.
 *
 * This is not a tuning knob — it is part of how the model was trained, and
 * getting it wrong quietly costs recall rather than failing. The MiniLM
 * sentence-transformers line is mean-pooled; the BGE family is trained to put
 * the sentence representation in the leading CLS token and mean-pooling them
 * measures a model nobody trained.
 */
export type LocalModelPooling = 'mean' | 'cls';

export interface LocalModelCandidate {
  /** Short id used on the command line and in settings: `minilm`, `bge-m3`. */
  id: string;
  /** Hugging Face repo the ONNX weights come from. */
  repo: string;
  /** Weight variant fetched. Quantized weights are a fraction of the download. */
  dtype: LocalModelDtype;
  /** Vector width. Drives index size for every chunk, permanently. */
  dims: number;
  /** Pooling the model was trained with. See {@link LocalModelPooling}. */
  pooling: LocalModelPooling;
  /** Measured bytes added to the cache by a cold load at `dtype`. */
  downloadBytes: number;
  /** Measured chunks encoded per second on CPU. Drives first-index wall clock. */
  chunksPerSec: number;
  /** `en` models are trained on English only; `multi` covers ~100 languages. */
  languages: 'en' | 'multi';
  /**
   * True when the model expects different prefixes for queries and passages.
   * See the header: such a model is measurable but not shippable through the
   * current single-method `Embedder` contract.
   */
  asymmetric?: boolean;
  /** One line for the settings UI and the scorecard. */
  note: string;
}

/**
 * `downloadBytes` and `chunksPerSec` below are measured, on an Apple Silicon
 * laptop, by loading each repo at the listed `dtype` into an otherwise-empty
 * cache and weighing what landed. Throughput is prose-sized chunks through the
 * CPU backend in batches of 16.
 *
 * Note how far the sizes move with `dtype`: the same four repos at fp32 are
 * 87 MB / 128 MB / 523 MB / ~2 GB. Quoting a model's size without its weight
 * variant — as the plan's "nomic at 270 MB" does — is not a size.
 */
export const LOCAL_MODELS: LocalModelCandidate[] = [
  {
    id: 'minilm',
    repo: 'Xenova/all-MiniLM-L6-v2',
    dtype: 'q8',
    dims: 384,
    pooling: 'mean',
    downloadBytes: 22_963_000,
    chunksPerSec: 121,
    languages: 'en',
    note: 'Smallest useful model. English sentence embeddings, 384 dimensions.',
  },
  {
    id: 'bge-small',
    repo: 'Xenova/bge-small-en-v1.5',
    dtype: 'q8',
    dims: 384,
    pooling: 'cls',
    downloadBytes: 33_973_000,
    chunksPerSec: 84,
    languages: 'en',
    note: 'Small English retrieval model. Same 384 dimensions as MiniLM.',
  },
  {
    id: 'nomic',
    repo: 'nomic-ai/nomic-embed-text-v1.5',
    dtype: 'q8',
    dims: 768,
    pooling: 'mean',
    downloadBytes: 137_259_000,
    chunksPerSec: 22,
    languages: 'en',
    asymmetric: true,
    note: 'Long-context English retrieval model. Wants query/passage prefixes.',
  },
  {
    id: 'bge-m3',
    repo: 'Xenova/bge-m3',
    dtype: 'q8',
    dims: 1024,
    pooling: 'cls',
    downloadBytes: 586_761_000,
    chunksPerSec: 8,
    languages: 'multi',
    note: 'Multilingual, 1024 dimensions. Largest download and slowest to index.',
  },
];

/**
 * The shipped default, chosen against the golden set (53 questions, 21,073
 * chunks). Dense arm only — the RRF constants were derived against 1536-dim
 * OpenAI vectors, so a hybrid comparison would confound the embedder with
 * weights that were never tuned for it.
 *
 *   BM25-only (what a keyless install gets today)  39.6% r@5 / 0.231 MRR
 *   MiniLM-L6-v2 q8                                28.3% / 0.220   (23 MB)
 *   bge-small-en-v1.5 q8                           45.3% / 0.338   (34 MB)
 *   bge-small-en-v1.5 fp32                         41.5% / 0.313   (128 MB)
 *   OpenAI text-embedding-3-small                  50.9% / 0.387
 *
 * The decisive result is the negative one: MiniLM lands 11pp *below* the
 * keyless baseline, so shipping the smallest model would have made a no-key
 * install worse at retrieval than it is with no model at all. Size was the
 * wrong axis to choose on.
 *
 * bge-small reaches 89% of OpenAI's recall for a 34 MB download, and q8 costs
 * nothing measurable against fp32 while being a quarter of the size — the
 * two-question gap is noise at n=53 and it favours q8 anyway.
 *
 * **The overall number hides two regressions; do not quote it alone.** Per
 * source class, dense·bge-small beats BM25 decisively on `docs` (40.9% vs
 * 27.3%) and `design` (50.0% vs 25.0%), but LOSES on recall in `plans` (50.0%
 * vs 66.7%) and `rules` (44.4% vs 55.6%) — and on the `semantic`-tagged subset
 * the questions written specifically to defeat keyword matching (30.3% vs
 * 36.4%), while still winning their MRR. Only the hybrid recovers those: RRF
 * over bge-small is at or above BM25 in every class except `plans`. A model
 * chosen on the overall figure alone would ship a quiet regression in the two
 * classes holding this repo's conventions.
 *
 * Read `plans` with its n in view: 6 golden questions against 17,850 indexed
 * chunks, the corpus's largest class by an order of magnitude and its
 * thinnest-sampled. One question moves it 16.7 points.
 *
 * Two candidates are excluded rather than defaulted-against, both on grounds
 * that hold whatever their recall turns out to be: nomic-embed-text-v1.5 needs
 * asymmetric `search_query:`/`search_document:` prefixes that `Embedder.embed`
 * cannot express, and bge-m3 is a 560 MB download against a plan risk that
 * calls a multi-hundred-megabyte first run unacceptable. Neither was measured.
 */
export const DEFAULT_LOCAL_MODEL_ID = 'bge-small';

/**
 * Parse a model spec — `repo`, `repo@dtype`, or `repo@dtype/pooling` — into the
 * three things that determine the vectors.
 *
 * The qualified form is what `EmbedderInfo.model` reports, so an identity read
 * back out of the store or off a scorecard column can be fed straight back in
 * and reproduce that exact index. Unqualified parts fall back to the registry
 * entry for the repo, then to the conservative defaults.
 *
 * Hugging Face repo ids contain a slash but never an '@', so the '@' split runs
 * first and the repo's own slash is never mistaken for the pooling separator.
 */
export function parseLocalModelSpec(spec: string): {
  repo: string;
  dtype?: LocalModelDtype;
  pooling?: LocalModelPooling;
} {
  const [repo, suffix] = spec.split('@');
  const [dtype, pooling] = (suffix ?? '').split('/');
  return {
    repo,
    dtype: (dtype || undefined) as LocalModelDtype | undefined,
    pooling: (pooling || undefined) as LocalModelPooling | undefined,
  };
}

export function findLocalModel(idOrRepo: string): LocalModelCandidate | undefined {
  return LOCAL_MODELS.find((m) => m.id === idOrRepo || m.repo === idOrRepo);
}

/**
 * The models a user may actually choose.
 *
 * Asymmetric entries are deliberately absent: they exist in `LOCAL_MODELS` so
 * the eval harness can score them if the `Embedder` contract ever grows a
 * query/passage distinction, but offering one in the UI today would ship it in
 * a configuration its authors warn against.
 */
export function selectableLocalModels(): LocalModelCandidate[] {
  return LOCAL_MODELS.filter((m) => !m.asymmetric);
}

/** The default candidate, resolved. Throws only if the registry is edited wrong. */
export function defaultLocalModel(): LocalModelCandidate {
  const model = findLocalModel(DEFAULT_LOCAL_MODEL_ID);
  if (!model) throw new Error(`DEFAULT_LOCAL_MODEL_ID "${DEFAULT_LOCAL_MODEL_ID}" is not in LOCAL_MODELS`);
  return model;
}

const MB = 1024 * 1024;

/** `34 MB` / `0.5 GB` — for a consent prompt that states the cost up front. */
export function formatDownloadSize(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)} GB`;
  return `${Math.round(bytes / MB)} MB`;
}
