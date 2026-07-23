import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEmbedder } from '../embedders/factory.js';
import { MemoryEngine } from '../engine.js';
import type { EngineConfig } from '../types.js';

vi.mock('../embedders/localEmbedder.js', () => ({
  LocalEmbedder: { load: vi.fn() },
}));

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): EngineConfig {
  const root = mkdtempSync(path.join(tmpdir(), 'mem-sparse-'));
  roots.push(root);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(
    path.join(root, 'docs/local-search.md'),
    '# Local Search\nThe quartz-orchid index is available entirely on this machine.',
  );
  writeFileSync(
    path.join(root, 'docs/unrelated.md'),
    '# Other\nThis document discusses release checklists and packaging.',
  );
  return {
    root,
    dbPath: path.join(root, 'index.db'),
    factsDir: 'voice-memory',
    sources: [{ sourceClass: 'docs', include: ['docs/**/*.md'] }],
  };
}

describe('sparse-only retrieval', () => {
  it('indexes and searches project markdown without dense vectors or network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const embedder = await createEmbedder({ kind: 'sparse' });
    expect(embedder.info).toEqual({ id: 'sparse', model: 'bm25', dims: 0 });

    const engine = MemoryEngine.create(setup(), embedder);
    await engine.indexAll();
    const hits = await engine.search('quartz-orchid', 3);
    const status = engine.status();

    expect(hits[0].sourcePath).toBe('docs/local-search.md');
    expect(hits[0].signals).toEqual({ dense: false, sparse: true });
    expect(status.denseChunks).toBe(0);
    expect(status.retrieval).toEqual({
      mode: 'keyword-only',
      semantic: {
        available: false,
        reason: 'optional-embedding-provider-unavailable',
      },
      keyword: { available: true, source: 'local-project-index' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await engine.close();
  });
});
