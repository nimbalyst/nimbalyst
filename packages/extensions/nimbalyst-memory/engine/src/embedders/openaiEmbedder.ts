/**
 * OpenAI embeddings via the REST API (no SDK dependency — uses global fetch).
 * Key-source-agnostic: the apiKey is supplied explicitly by the caller at
 * construction. The engine never reads it from the environment implicitly.
 */
import type { Embedder, EmbedderInfo } from '../types.js';

export interface OpenAIEmbedderConfig {
  apiKey: string;
  /** Default: text-embedding-3-small. */
  model?: string;
  /** Default: 1536 (text-embedding-3-small native dim). */
  dims?: number;
  /** Override for OpenAI-compatible gateways. Default: https://api.openai.com/v1 */
  baseUrl?: string;
  /** Max texts per request. Default: 128. */
  batchSize?: number;
}

const DEFAULT_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMS = 1536;
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_BATCH = 128;

export class OpenAIEmbedder implements Embedder {
  readonly info: EmbedderInfo;
  private apiKey: string;
  private baseUrl: string;
  private batchSize: number;

  constructor(config: OpenAIEmbedderConfig) {
    if (!config.apiKey) throw new Error('OpenAIEmbedder requires an apiKey');
    const model = config.model ?? DEFAULT_MODEL;
    const dims = config.dims ?? DEFAULT_DIMS;
    this.info = { id: 'openai', model, dims };
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.batchSize = config.batchSize ?? DEFAULT_BATCH;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      out.push(...(await this.embedBatch(batch)));
    }
    return out;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = { model: this.info.model, input: batch };
    // text-embedding-3-* support an explicit `dimensions` truncation.
    if (this.info.model.startsWith('text-embedding-3')) body.dimensions = this.info.dims;

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings failed (${res.status}): ${detail.slice(0, 500)}`);
    }
    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    // Preserve input order regardless of response ordering.
    return json.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
