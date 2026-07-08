import type { Embedder, EmbedderInfo } from '../types.js';

/**
 * Deterministic bag-of-words embedder for tests: hashes tokens into a fixed-dim
 * space and L2-normalizes. No network, fully reproducible — cosine over these
 * vectors meaningfully reflects token overlap.
 */
export class FakeEmbedder implements Embedder {
  readonly info: EmbedderInfo;
  constructor(id = 'fake', model = 'fake-bow', private dims = 32) {
    this.info = { id, model, dims };
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  private vector(text: string): number[] {
    const v = new Array(this.dims).fill(0);
    for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
      v[h % this.dims] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}
