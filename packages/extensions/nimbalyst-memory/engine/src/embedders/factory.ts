/** Construct an Embedder from declarative config. */
import type { Embedder } from '../types.js';
import { OpenAIEmbedder, type OpenAIEmbedderConfig } from './openaiEmbedder.js';
import { LocalEmbedder, type LocalEmbedderConfig } from './localEmbedder.js';
import { SparseEmbedder } from './sparseEmbedder.js';

export type EmbedderConfig =
  | ({ kind: 'openai' } & OpenAIEmbedderConfig)
  | ({ kind: 'local' } & LocalEmbedderConfig)
  | { kind: 'sparse' };

export async function createEmbedder(config: EmbedderConfig): Promise<Embedder> {
  switch (config.kind) {
    case 'openai':
      return new OpenAIEmbedder(config);
    case 'local':
      return LocalEmbedder.load(config);
    case 'sparse':
      return new SparseEmbedder();
    default: {
      const exhaustive: never = config;
      throw new Error(`Unknown embedder kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
