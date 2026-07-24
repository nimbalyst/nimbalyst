import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, rmSync as unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Indexer } from '../indexer/indexer.js';
import { SqliteStore } from '../store/sqliteStore.js';
import { Retriever } from '../retrieval/retriever.js';
import { FakeEmbedder } from './fakeEmbedder.js';
import type { EngineConfig } from '../types.js';

const roots: string[] = [];
function setup(): { root: string; config: EngineConfig } {
  const root = mkdtempSync(path.join(tmpdir(), 'mem-idx-'));
  roots.push(root);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  const config: EngineConfig = {
    root,
    dbPath: path.join(root, 'index.db'),
    factsDir: 'voice-memory',
    sources: [{ sourceClass: 'docs', include: ['docs/**/*.md'] }],
  };
  return { root, config };
}
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Indexer', () => {
  it('indexes markdown, embeds chunks, and makes them searchable', async () => {
    const { root, config } = setup();
    writeFileSync(
      path.join(root, 'docs/voice.md'),
      '# Voice Agent\nThe realtime voice agent calls grounding tools over MCP.'
    );
    writeFileSync(path.join(root, 'docs/cooking.md'), '# Bread\nHow to bake sourdough.');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    const result = await indexer.indexAll();
    expect(result.files).toBe(2);
    expect(result.indexed).toBeGreaterThanOrEqual(2);

    const retriever = new Retriever(store.loadAll());
    const embedder = new FakeEmbedder();
    const [qv] = await embedder.embed(['realtime voice grounding']);
    const hits = retriever.search('realtime voice grounding', qv, 2);
    expect(hits[0].sourcePath).toBe('docs/voice.md');
    store.close();
  });

  it('re-embeds only changed chunks on the next pass', async () => {
    const { root, config } = setup();
    const a = path.join(root, 'docs/a.md');
    const b = path.join(root, 'docs/b.md');
    writeFileSync(a, '# A\nalpha content here');
    writeFileSync(b, '# B\nbeta content here');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    await indexer.indexAll();

    // Edit only a.md; b.md is unchanged.
    writeFileSync(a, '# A\nalpha content here, now revised');
    const reembedA = await indexer.indexFile('docs/a.md', 'docs');
    const reembedB = await indexer.indexFile('docs/b.md', 'docs');
    expect(reembedA).toBeGreaterThanOrEqual(1);
    expect(reembedB).toBe(0); // unchanged ⇒ reused embedding
    store.close();
  });

  it('excludes files matching config.exclude (e.g. archive/**) from index + classify', async () => {
    const { root, config } = setup();
    config.exclude = ['**/archive/**'];
    mkdirSync(path.join(root, 'docs/archive'), { recursive: true });
    writeFileSync(path.join(root, 'docs/current.md'), '# Current\nlive truth');
    writeFileSync(path.join(root, 'docs/archive/old.md'), '# Old\nstale abandoned plan');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    await indexer.indexAll();
    // Only the non-archived file is indexed.
    expect(store.sourcePaths()).toEqual(['docs/current.md']);
    // classify (used by the watcher) also rejects excluded paths.
    expect(indexer.classify('docs/archive/old.md')).toBeNull();
    expect(indexer.classify('docs/current.md')).toBe('docs');
    store.close();
  });

  it('prunes files deleted from disk', async () => {
    const { root, config } = setup();
    writeFileSync(path.join(root, 'docs/keep.md'), '# Keep\nstays');
    const gone = path.join(root, 'docs/gone.md');
    writeFileSync(gone, '# Gone\nremoved later');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    await indexer.indexAll();
    expect(store.sourcePaths().sort()).toEqual(['docs/gone.md', 'docs/keep.md']);

    unlinkSync(gone, { force: true });
    await indexer.indexAll();
    expect(store.sourcePaths()).toEqual(['docs/keep.md']);
    store.close();
  });
});
