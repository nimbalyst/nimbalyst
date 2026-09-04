/**
 * Local, offline embeddings via transformers.js (ONNX). This is the keyless
 * semantic path: no API key, no network at query time, nothing leaves the
 * machine.
 *
 * transformers.js is an OPTIONAL dependency and is lazy-loaded — the engine
 * works without it (OpenAI or BM25-only) and only fails if the local embedder
 * is actually selected without the package installed. `backend.ts` treats every
 * failure here as "fall back to sparse", so a missing package, a missing model,
 * or a corrupt cache degrades retrieval rather than breaking activation.
 *
 * Two behaviours exist specifically to keep the first run safe:
 *
 *  - **`allowDownload` defaults to false.** Loading only ever reads an
 *    already-cached model. A model that is not on disk throws, and the caller
 *    degrades. Fetching the weights is a separate, explicit act
 *    (`downloadModel`), because a multi-hundred-megabyte download nobody asked
 *    for on first launch is the headline risk of this whole feature.
 *  - **`cacheDir` is always absolute and outside the project tree.**
 *    transformers.js would otherwise default to `./.cache`, relative to the
 *    process cwd — which in a utility process is the user's workspace. See
 *    `modelCache.ts`.
 *
 * Dimensions are probed from the model on load rather than hardcoded, so the
 * store always records the true `dims` (switching models forces a re-index).
 */
import type { Embedder, EmbedderInfo } from '../types.js';
import {
  defaultLocalModel,
  findLocalModel,
  parseLocalModelSpec,
  type LocalModelPooling,
} from './localModels.js';
import { resolveModelCacheDir } from './modelCache.js';

export interface LocalEmbedderConfig {
  /** Hugging Face repo id. Default: {@link DEFAULT_LOCAL_MODEL}. */
  model?: string;
  /** Optional pin; otherwise probed from the model on load. */
  dims?: number;
  /** L2-normalize the pooled vector, so cosine is a dot product. Default: true. */
  normalize?: boolean;
  /**
   * Pooling strategy. Defaults to the registry entry for `model`, then to mean.
   * This is a property of how the model was trained, not a preference — see
   * {@link LocalModelPooling}.
   */
  pooling?: LocalModelPooling;
  /** Absolute model cache dir. Default: {@link resolveModelCacheDir}. */
  cacheDir?: string;
  /**
   * Permit fetching weights from the Hugging Face hub. Default FALSE: an
   * uncached model is an error, not a silent download.
   */
  allowDownload?: boolean;
  /** ONNX weight precision, e.g. 'fp32' | 'q8'. Default: {@link DEFAULT_DTYPE}. */
  dtype?: string;
  /** Texts per forward pass. Default: {@link DEFAULT_BATCH_SIZE}. */
  batchSize?: number;
  /**
   * Prefix prepended to every text before encoding. Some retrieval models
   * (nomic-embed-*, e5-*) are trained with an instruction prefix and score
   * poorly without one. Applied uniformly to documents and queries because
   * `Embedder.embed` carries no doc/query distinction.
   */
  prefix?: string;
  /** Progress during weight download, when `allowDownload` is set. */
  onProgress?: (event: ModelDownloadProgress) => void;
}

export interface ModelDownloadProgress {
  /** transformers.js status: 'initiate' | 'download' | 'progress' | 'done'. */
  status: string;
  file?: string;
  /** 0-100 while a file is streaming. */
  progress?: number;
  loaded?: number;
  total?: number;
}

/**
 * Model and weight variant when the caller does not name one. Both come from
 * the measured registry in `localModels.ts` rather than being spelled out here,
 * so the size shown in a consent prompt and the bytes actually fetched can
 * never drift apart.
 *
 * `q8` rather than `fp32` is worth a word: quantized weights are roughly a
 * quarter of the download on every candidate measured (23 MB vs 87 MB for
 * MiniLM), and "model download" is a named risk in the plan. Whether that
 * saving costs recall is a golden-set question, not an assumption — the
 * scorecard on NIM-5462 records both variants of the default model.
 */
export const DEFAULT_LOCAL_MODEL = defaultLocalModel().repo;
const DEFAULT_DTYPE: string = defaultLocalModel().dtype;
const DEFAULT_BATCH_SIZE = 16;

// transformers.js types are not available at build time (optional dep).
type FeatureExtractionPipeline = (
  texts: string | string[],
  opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean }
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

interface TransformersModule {
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
  env: {
    cacheDir: string;
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    useFSCache: boolean;
  };
}

async function importTransformers(): Promise<TransformersModule> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await import('@huggingface/transformers' as any)) as TransformersModule;
  } catch {
    throw new Error(
      'LocalEmbedder requires the optional dependency "@huggingface/transformers". ' +
        'Install it, or use the OpenAI embedder instead.'
    );
  }
}

/**
 * Point transformers.js at our cache and set the download gate.
 *
 * `allowLocalModels` stays true even when downloads are forbidden: it is what
 * lets the filesystem cache satisfy a load. Turning both off makes
 * `getModelFile` throw "both local and remote models are disabled" before it
 * ever looks at the cache.
 */
function configureEnv(env: TransformersModule['env'], cacheDir: string, allowDownload: boolean) {
  env.cacheDir = cacheDir;
  env.useFSCache = true;
  env.allowLocalModels = true;
  env.allowRemoteModels = allowDownload;
}

let supported: Promise<boolean> | null = null;

/**
 * True when the optional ONNX runtime is present, i.e. local embeddings are
 * possible on this machine at all. Memoized: the import is several seconds and
 * a large resident allocation, and this is polled by a settings panel.
 */
export function isLocalEmbedderSupported(): Promise<boolean> {
  supported ??= importTransformers().then(
    () => true,
    () => false
  );
  return supported;
}

/** True when the model's weights are already on disk in `cacheDir`. */
export async function isModelCached(config: LocalEmbedderConfig = {}): Promise<boolean> {
  try {
    await LocalEmbedder.load({ ...config, allowDownload: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch a model's weights into the shared cache. The ONLY code path that is
 * allowed to hit the network for weights — everything else loads cache-only.
 */
export async function downloadModel(config: LocalEmbedderConfig = {}): Promise<EmbedderInfo> {
  const embedder = await LocalEmbedder.load({ ...config, allowDownload: true });
  return embedder.info;
}

export class LocalEmbedder implements Embedder {
  readonly info: EmbedderInfo;
  private pipe: FeatureExtractionPipeline;
  private normalize: boolean;
  private batchSize: number;
  private prefix: string;
  private pooling: LocalModelPooling;

  private constructor(
    info: EmbedderInfo,
    pipe: FeatureExtractionPipeline,
    opts: { normalize: boolean; batchSize: number; prefix: string; pooling: LocalModelPooling }
  ) {
    this.info = info;
    this.pipe = pipe;
    this.normalize = opts.normalize;
    this.batchSize = opts.batchSize;
    this.prefix = opts.prefix;
    this.pooling = opts.pooling;
  }

  /** Load the ONNX model and probe its true dimensionality. */
  static async load(config: LocalEmbedderConfig = {}): Promise<LocalEmbedder> {
    // `repo`, `repo@dtype` and `repo@dtype/pooling` are all accepted here — see
    // `parseLocalModelSpec`.
    const spec = parseLocalModelSpec(config.model || DEFAULT_LOCAL_MODEL);
    const model = spec.repo;
    const normalize = config.normalize ?? true;
    const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    const prefix = config.prefix ?? '';
    const cacheDir = config.cacheDir || resolveModelCacheDir();
    // A registry entry's dtype is the variant its measured download size refers
    // to, so an unqualified request for a known model must fetch that variant.
    const dtype = spec.dtype || config.dtype || findLocalModel(model)?.dtype || DEFAULT_DTYPE;
    const pooling =
      spec.pooling ??
      config.pooling ??
      findLocalModel(model)?.pooling ??
      'mean';

    const transformers = await importTransformers();
    configureEnv(transformers.env, cacheDir, config.allowDownload === true);

    const pipe = (await transformers.pipeline('feature-extraction', model, {
      dtype,
      ...(config.onProgress ? { progress_callback: config.onProgress } : {}),
    })) as FeatureExtractionPipeline;

    let dims = config.dims;
    if (!dims) {
      const probe = await pipe('dimension probe', { pooling, normalize });
      dims = probe.dims[probe.dims.length - 1];
    }
    // dtype AND pooling are ALWAYS part of the identity. Both change the vectors
    // a repo produces, so an index built under one must not be reused under the
    // other, and spelling both out unconditionally means changing a registry
    // default later cannot silently alias two different vector spaces onto one
    // index. The store compares this string and forces a re-index when it moves.
    const identity = `${model}@${dtype}/${pooling}`;
    return new LocalEmbedder({ id: 'local', model: identity, dims }, pipe, {
      normalize,
      batchSize,
      prefix,
      pooling,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    // Batched: one forward pass per `batchSize` texts rather than per text.
    // On a 20k-chunk index that is the difference between minutes and an hour.
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const input = this.prefix ? batch.map((t) => this.prefix + t) : batch;
      const res = await this.pipe(input, { pooling: this.pooling, normalize: this.normalize });
      const data = res.data as Float32Array;
      const dims = res.dims[res.dims.length - 1];
      for (let row = 0; row < batch.length; row++) {
        out.push(Array.from(data.slice(row * dims, (row + 1) * dims)));
      }
    }
    return out;
  }
}
