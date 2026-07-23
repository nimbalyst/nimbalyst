import type { Embedder } from '../types.js';

/** Local keyword-only mode. Dense vectors are intentionally absent. */
export class SparseEmbedder implements Embedder {
  readonly info = { id: 'sparse', model: 'bm25', dims: 0 } as const;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}
