import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../store/sqliteStore.js';
import type { StoredChunk } from '../types.js';

const dirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mem-store-'));
  dirs.push(dir);
  return path.join(dir, 'index.db');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function chunk(id: string, sourcePath: string, ordinal: number, text: string): StoredChunk {
  return {
    id,
    sourcePath,
    sourceClass: 'docs',
    headingPath: ['H'],
    ordinal,
    text,
    contentHash: `hash-${id}`,
    denseEmbedding: [0.1, 0.2, 0.3],
    sparseTerms: { foo: 1 },
    embedderId: 'fake',
    model: 'fake-bow',
    dims: 3,
    updatedAt: 1,
    refType: 'doc-file',
    refId: sourcePath,
  };
}

describe('SqliteStore', () => {
  it('round-trips chunks including the dense vector and sparse terms', () => {
    const store = new SqliteStore(tmpDb());
    store.upsertChunks([chunk('a#0', 'a.md', 0, 'hello')]);
    const all = store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].denseEmbedding).toEqual([
      expect.closeTo(0.1, 5),
      expect.closeTo(0.2, 5),
      expect.closeTo(0.3, 5),
    ]);
    expect(all[0].sparseTerms).toEqual({ foo: 1 });
    expect(store.count()).toBe(1);
    store.close();
  });

  it('records embedder identity and persists it', () => {
    const dbPath = tmpDb();
    const store = new SqliteStore(dbPath);
    expect(store.getEmbedderInfo()).toBeNull();
    store.setEmbedderInfo({ id: 'openai', model: 'text-embedding-3-small', dims: 1536 });
    store.close();

    const reopened = new SqliteStore(dbPath);
    expect(reopened.getEmbedderInfo()).toEqual({
      id: 'openai',
      model: 'text-embedding-3-small',
      dims: 1536,
    });
    reopened.close();
  });

  it('prunes stale chunk ids for a source but keeps the rest', () => {
    const store = new SqliteStore(tmpDb());
    store.upsertChunks([
      chunk('a#0', 'a.md', 0, 'one'),
      chunk('a#1', 'a.md', 1, 'two'),
      chunk('a#2', 'a.md', 2, 'three'),
    ]);
    store.pruneSource('a.md', ['a#0', 'a#1']);
    expect(store.chunksForSource('a.md').map((c) => c.id)).toEqual(['a#0', 'a#1']);
    store.close();
  });

  it('reset() clears chunks for an embedder switch', () => {
    const store = new SqliteStore(tmpDb());
    store.upsertChunks([chunk('a#0', 'a.md', 0, 'hello')]);
    store.reset();
    expect(store.count()).toBe(0);
    store.close();
  });
});
