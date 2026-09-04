// @vitest-environment node
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
    expect(indexer.classify('docs/current.md')?.sourceClass).toBe('docs');
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

/**
 * A second root breaks the assumption that "relative to root" is a unique key.
 * These cover the collision itself and the pruning that keys off it — a same-named
 * file in two roots must not let one root's deletion evict the other's row.
 */
describe('Indexer with a second source root', () => {
  function setupTwoRoots(): { root: string; second: string; config: EngineConfig } {
    const { root, config } = setup();
    const secondHome = mkdtempSync(path.join(tmpdir(), 'mem-idx-second-'));
    roots.push(secondHome);
    const second = path.join(secondHome, 'memory');
    mkdirSync(second, { recursive: true });
    config.sources = [
      { sourceClass: 'docs', include: ['docs/**/*.md'] },
      {
        sourceClass: 'harness-memory',
        include: ['**/*.md'],
        root: { id: 'memory', path: second, personal: true },
      },
    ];
    return { root, second, config };
  }

  it('keys a same-named file in each root distinctly, and reads each back', async () => {
    const { root, second, config } = setupTwoRoots();
    writeFileSync(path.join(root, 'docs/README.md'), '# Readme\nprimary copy');
    writeFileSync(path.join(second, 'README.md'), '# Readme\nsecond-root copy');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    const result = await indexer.indexAll();
    expect(result.files).toBe(2);
    // Without the root prefix these two collide on the chunk primary key and one
    // silently overwrites the other.
    expect(store.sourcePaths().sort()).toEqual(['@memory/README.md', 'docs/README.md']);

    const bySource = new Map(
      store.sourcePaths().map((sp) => [sp, store.chunksForSource(sp).map((c) => c.text).join('')])
    );
    expect(bySource.get('docs/README.md')).toContain('primary copy');
    expect(bySource.get('@memory/README.md')).toContain('second-root copy');

    // refId is the openable identifier. A caller resolves a relative one against
    // the workspace path, which cannot reach a second root — so those chunks
    // carry an absolute path or the hit is findable but not openable.
    expect(store.chunksForSource('docs/README.md')[0].refId).toBe('docs/README.md');
    expect(store.chunksForSource('@memory/README.md')[0].refId).toBe(
      path.join(second, 'README.md')
    );
    store.close();
  });

  it('attributes deletion pruning to the root the file was removed from', async () => {
    const { root, second, config } = setupTwoRoots();
    writeFileSync(path.join(root, 'docs/README.md'), '# Readme\nprimary copy');
    const secondReadme = path.join(second, 'README.md');
    writeFileSync(secondReadme, '# Readme\nsecond-root copy');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());
    await indexer.indexAll();

    unlinkSync(secondReadme, { force: true });
    await indexer.indexAll();
    expect(store.sourcePaths()).toEqual(['docs/README.md']);
    store.close();
  });

  it('classifies by root, so a glob on one root never claims the other root files', async () => {
    const { root, second, config } = setupTwoRoots();
    // 'docs/**/*.md' belongs to the primary root only.
    mkdirSync(path.join(second, 'docs'), { recursive: true });
    writeFileSync(path.join(second, 'docs/x.md'), '# X\nunder the second root');
    writeFileSync(path.join(root, 'docs/x.md'), '# X\nunder the primary root');

    const store = new SqliteStore(config.dbPath);
    const indexer = new Indexer(config, store, new FakeEmbedder());

    expect(indexer.classify(path.join(root, 'docs/x.md'))).toEqual({
      sourceClass: 'docs',
      sourcePath: 'docs/x.md',
    });
    // Matched by the second root's own '**/*.md', NOT by the primary 'docs' set.
    expect(indexer.classify(path.join(second, 'docs/x.md'))).toEqual({
      sourceClass: 'harness-memory',
      sourcePath: '@memory/docs/x.md',
    });
    // Outside every root.
    expect(indexer.classify(path.join(tmpdir(), 'nowhere-at-all', 'docs/x.md'))).toBeNull();
    store.close();
  });
});
