import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryEngine } from '../engine.js';
import type { EngineConfig, VirtualRecord } from '../types.js';
import { FakeEmbedder } from './fakeEmbedder.js';

const roots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mem-vrec-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeEngine(root: string): MemoryEngine {
  const config: EngineConfig = {
    root,
    dbPath: path.join(root, 'index.db'),
    factsDir: 'facts',
    // One on-disk source class so we can prove the file pass never prunes records.
    sources: [{ sourceClass: 'docs', include: ['docs/**/*.md'] }],
  };
  return MemoryEngine.create(config, new FakeEmbedder());
}

function rec(id: string, title: string, text: string): VirtualRecord {
  return { id, sourceClass: 'trackers', refType: 'tracker', refId: id.replace(/^tracker:/, ''), title, text };
}

describe('MemoryEngine virtual records', () => {
  it('ingests records and finds them by hybrid search, carrying refType/refId', async () => {
    const engine = makeEngine(tmpRoot());
    await engine.ingestRecords([
      rec('tracker:NIM-1', 'Login crash on empty password', 'The auth form throws when the password field is blank.'),
      rec('tracker:NIM-2', 'Sourdough recipe', 'How to bake bread with a wild yeast starter.'),
    ]);

    const hits = await engine.search('authentication blank password bug', 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].refType).toBe('tracker');
    expect(hits[0].refId).toBe('NIM-1');
    await engine.close();
  });

  it('removeRecords drops a record from results; unknown ids are no-ops', async () => {
    const engine = makeEngine(tmpRoot());
    await engine.ingestRecords([rec('tracker:NIM-9', 'Unique marker zylophone', 'zylophone unique token body')]);
    expect((await engine.search('zylophone', 5)).length).toBe(1);

    engine.removeRecords(['tracker:does-not-exist']); // no-op
    expect((await engine.search('zylophone', 5)).length).toBe(1);

    engine.removeRecords(['tracker:NIM-9']);
    expect((await engine.search('zylophone', 5)).length).toBe(0);
    await engine.close();
  });

  it('re-embeds only changed records (dirty-check by content hash)', async () => {
    const engine = makeEngine(tmpRoot());
    const r1 = rec('tracker:A', 'Title A', 'body one');
    const r2 = rec('tracker:B', 'Title B', 'body two');
    expect((await engine.ingestRecords([r1, r2])).ingested).toBeGreaterThan(0);

    // Re-ingest unchanged → zero (re)embeds.
    expect((await engine.ingestRecords([r1, r2])).ingested).toBe(0);

    // Change one body → exactly that record re-embeds.
    const r2b = rec('tracker:B', 'Title B', 'body two CHANGED substantially');
    expect((await engine.ingestRecords([r1, r2b])).ingested).toBe(1);
    await engine.close();
  });

  it('a markdown re-index never prunes virtual records', async () => {
    const root = tmpRoot();
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs', 'a.md'), '# Doc\n\nsome file content here\n');

    const engine = makeEngine(root);
    await engine.indexAll();
    await engine.ingestRecords([rec('tracker:keep', 'Keep me', 'durable catalog record body')]);
    const present = async () =>
      (await engine.search('durable catalog record', 5)).some(
        (h) => h.refType === 'tracker' && h.refId === 'keep'
      );
    expect(await present()).toBe(true);

    // A full file re-index (which prunes deleted files) must leave the record intact.
    await engine.indexAll();
    expect(await present()).toBe(true);
    await engine.close();
  });
});
