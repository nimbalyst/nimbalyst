/**
 * Local, offline embeddings via transformers.js (ONNX). Default model is
 * `Xenova/bge-m3` (multilingual). transformers.js is an OPTIONAL dependency and
 * is lazy-loaded — the engine works without it (OpenAI path) and only fails if
 * the local embedder is actually selected without the package installed.
 *
 * Dimensions are probed from the model on load rather than hardcoded, so the
 * store always records the true `dims` (switching models forces a re-index).
 */
import type { Embedder, EmbedderInfo } from '../types.js';

export interface LocalEmbedderConfig {
  /** Default: Xenova/bge-m3. */
  model?: string;
  /** Optional pin; otherwise probed from the model on load. */
  dims?: number;
  /** Mean-pool + normalize (recommended for bge-* models). Default: true. */
  normalize?: boolean;
}

const DEFAULT_MODEL = 'Xenova/bge-m3';

// transformers.js types are not available at build time (optional dep).
type FeatureExtractionPipeline = (
  texts: string | string[],
  opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean }
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

async function loadPipeline(model: string): Promise<FeatureExtractionPipeline> {
  let transformers: { pipeline: (task: string, model: string) => Promise<unknown> };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transformers = (await import('@huggingface/transformers' as any)) as typeof transformers;
  } catch {
    throw new Error(
      'LocalEmbedder requires the optional dependency "@huggingface/transformers". ' +
        'Install it, or use the OpenAI embedder instead.'
    );
  }
  return (await transformers.pipeline('feature-extraction', model)) as FeatureExtractionPipeline;
}

export class LocalEmbedder implements Embedder {
  readonly info: EmbedderInfo;
  private pipe: FeatureExtractionPipeline;
  private normalize: boolean;

  private constructor(info: EmbedderInfo, pipe: FeatureExtractionPipeline, normalize: boolean) {
    this.info = info;
    this.pipe = pipe;
    this.normalize = normalize;
  }

  /** Load the ONNX model and probe its true dimensionality. */
  static async load(config: LocalEmbedderConfig = {}): Promise<LocalEmbedder> {
    const model = config.model ?? DEFAULT_MODEL;
    const normalize = config.normalize ?? true;
    const pipe = await loadPipeline(model);
    let dims = config.dims;
    if (!dims) {
      const probe = await pipe('dimension probe', { pooling: 'mean', normalize });
      dims = probe.dims[probe.dims.length - 1];
    }
    return new LocalEmbedder({ id: 'local', model, dims }, pipe, normalize);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    // transformers.js batches internally but keep memory bounded for big indexes.
    for (const text of texts) {
      const res = await this.pipe(text, { pooling: 'mean', normalize: this.normalize });
      out.push(Array.from(res.data as Float32Array));
    }
    return out;
  }
}
