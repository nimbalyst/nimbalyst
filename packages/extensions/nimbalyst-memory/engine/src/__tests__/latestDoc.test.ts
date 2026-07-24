import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryEngine } from '../engine.js';
import { FakeEmbedder } from './fakeEmbedder.js';
import type { EngineConfig } from '../types.js';

const roots: string[] = [];
function setup(): { root: string; config: EngineConfig } {
  const root = mkdtempSync(path.join(tmpdir(), 'mem-latest-'));
  roots.push(root);
  mkdirSync(path.join(root, 'plans'), { recursive: true });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  const config: EngineConfig = {
    root,
    dbPath: path.join(root, 'index.db'),
    factsDir: 'voice-memory',
    sources: [
      { sourceClass: 'plans', include: ['plans/**/*.md'] },
      { sourceClass: 'docs', include: ['docs/**/*.md'] },
    ],
    exclude: ['**/archive/**'],
  };
  return { root, config };
}
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a file and stamp its mtime to a fixed epoch-seconds value. */
function writeAt(abs: string, content: string, epochSeconds: number): void {
  writeFileSync(abs, content);
  utimesSync(abs, epochSeconds, epochSeconds);
}

describe('MemoryEngine.latestDoc', () => {
  it('returns the most-recently-modified doc in a source class, with content', async () => {
    const { root, config } = setup();
    writeAt(path.join(root, 'plans/old.md'), '# Old plan\nfirst', 1_000_000);
    writeAt(path.join(root, 'plans/new.md'), '# New plan\nlatest body', 2_000_000);
    // A newer doc in a DIFFERENT class must not win the 'plans' query.
    writeAt(path.join(root, 'docs/newer.md'), '# Doc\nirrelevant', 3_000_000);

    const engine = MemoryEngine.create(config, new FakeEmbedder());
    const latest = await engine.latestDoc('plans');
    expect(latest).not.toBeNull();
    expect(latest!.path).toBe('plans/new.md');
    expect(latest!.content).toContain('latest body');
    await engine.close();
  });

  it('returns null for a class with no files', async () => {
    const { config } = setup();
    const engine = MemoryEngine.create(config, new FakeEmbedder());
    expect(await engine.latestDoc('plans')).toBeNull();
    await engine.close();
  });

  it('honors config.exclude (archived plans never win)', async () => {
    const { root, config } = setup();
    mkdirSync(path.join(root, 'plans/archive'), { recursive: true });
    writeAt(path.join(root, 'plans/live.md'), '# Live\ncurrent', 1_000_000);
    // Archived file is newer but excluded.
    writeAt(path.join(root, 'plans/archive/stale.md'), '# Stale\nabandoned', 9_000_000);

    const engine = MemoryEngine.create(config, new FakeEmbedder());
    const latest = await engine.latestDoc('plans');
    expect(latest!.path).toBe('plans/live.md');
    await engine.close();
  });
});

describe('MemoryEngine.recentDocs', () => {
  it('returns the N most-recently-modified docs of a class, newest first', async () => {
    const { root, config } = setup();
    writeAt(path.join(root, 'plans/a.md'), '# A\nbody a', 1_000_000);
    writeAt(path.join(root, 'plans/b.md'), '# B\nbody b', 2_000_000);
    writeAt(path.join(root, 'plans/c.md'), '# C\nbody c', 3_000_000);
    writeAt(path.join(root, 'docs/d.md'), '# D\nother class', 4_000_000);

    const engine = MemoryEngine.create(config, new FakeEmbedder());
    const recent = await engine.recentDocs('plans', 2);
    expect(recent.map((d) => d.path)).toEqual(['plans/c.md', 'plans/b.md']);
    expect(recent[0].content).toContain('body c');
    await engine.close();
  });

  it('returns all docs when limit exceeds the class size, and [] for an empty class', async () => {
    const { root, config } = setup();
    writeAt(path.join(root, 'plans/only.md'), '# Only\nx', 1_000_000);
    const engine = MemoryEngine.create(config, new FakeEmbedder());
    expect((await engine.recentDocs('plans', 10)).map((d) => d.path)).toEqual(['plans/only.md']);
    expect(await engine.recentDocs('docs', 5)).toEqual([]);
    await engine.close();
  });
});
