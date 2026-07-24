import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FactsStore } from '../facts/facts.js';

const dirs: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mem-facts-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('FactsStore', () => {
  it('remember appends a new file and recall reads it back', async () => {
    const root = tmpRoot();
    const store = new FactsStore(root, 'voice-memory');
    const p = await store.remember({ text: 'Greg prefers no emojis', category: 'preference', priority: 5 });
    expect(p).toMatch(/^voice-memory\//);
    const facts = await store.recall({});
    expect(facts).toHaveLength(1);
    expect(facts[0].text).toBe('Greg prefers no emojis');
    expect(facts[0].category).toBe('preference');
    expect(facts[0].priority).toBe(5);
  });

  it('is ADD-only: two remembers create two files', async () => {
    const root = tmpRoot();
    const store = new FactsStore(root, 'voice-memory');
    await store.remember({ text: 'fact one' });
    await store.remember({ text: 'fact two' });
    expect(await store.recall({})).toHaveLength(2);
  });

  it('filters recall by category and scope', async () => {
    const root = tmpRoot();
    const store = new FactsStore(root, 'voice-memory');
    await store.remember({ text: 'global truth', category: 'project' });
    await store.remember({ text: 'ui detail', category: 'ui', scope: 'frontend' });
    const ui = await store.recall({ category: 'ui' });
    expect(ui.map((f) => f.text)).toEqual(['ui detail']);
  });

  it('ranks query recall by keyword relevance', async () => {
    const root = tmpRoot();
    const store = new FactsStore(root, 'voice-memory');
    await store.remember({ text: 'the database uses better-sqlite3 and pglite' });
    await store.remember({ text: 'voice mode uses the openai realtime api' });
    const hits = await store.recall({ query: 'realtime voice' });
    expect(hits[0].text).toContain('realtime');
  });

  it('top() orders by priority then recency', async () => {
    const root = tmpRoot();
    const dir = path.join(root, 'voice-memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'low.md'), '---\npriority: 1\n---\nlow priority');
    writeFileSync(path.join(dir, 'high.md'), '---\npriority: 9\n---\nhigh priority');
    const store = new FactsStore(root, 'voice-memory');
    const top = await store.top(1);
    expect(top[0].text).toBe('high priority');
  });

  it('delete removes a fact by its relative sourcePath', async () => {
    const root = tmpRoot();
    const store = new FactsStore(root, 'voice-memory');
    await store.remember({ text: 'keep me' });
    const target = await store.remember({ text: 'delete me' });
    expect(await store.recall({})).toHaveLength(2);
    const removed = await store.delete(target);
    expect(removed).toBe(true);
    const remaining = await store.recall({});
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe('keep me');
  });

  it('delete refuses paths that escape the facts dir', async () => {
    const root = tmpRoot();
    const store = new FactsStore(root, 'voice-memory');
    await expect(store.delete('../outside.md')).rejects.toThrow();
    await expect(store.delete('voice-memory/../../etc/hosts')).rejects.toThrow();
  });

  it('delete returns false for an unknown fact path', async () => {
    const root = tmpRoot();
    const store = new FactsStore(root, 'voice-memory');
    expect(await store.delete('voice-memory/nope.md')).toBe(false);
  });
});
