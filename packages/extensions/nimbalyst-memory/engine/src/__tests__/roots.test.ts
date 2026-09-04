// @vitest-environment node
/**
 * The multi-root path guard. `read_doc` hands the agent arbitrary file contents,
 * and the only thing bounding it is `resolveInRoots`. Adding a second root turned
 * one string comparison into a set-membership test, so the cases that matter are
 * the ones proving membership did not become permissiveness: an escape attempt
 * against EACH root, a path outside ALL roots, and an unrecognized root id.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryEngine } from '../engine.js';
import { FakeEmbedder } from './fakeEmbedder.js';
import { resolveInRoots, resolveRoots } from '../roots.js';
import { SqliteStore } from '../store/sqliteStore.js';
import type { EngineConfig } from '../types.js';

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Primary root with a docs/ tree, plus a separate personal 'memory' root. */
function setup(): { root: string; memoryDir: string; config: EngineConfig } {
  const root = mkTmp('mem-roots-primary-');
  const memoryHome = mkTmp('mem-roots-home-');
  const memoryDir = path.join(memoryHome, 'memory');
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  const config: EngineConfig = {
    root,
    dbPath: path.join(root, 'index.db'),
    factsDir: 'voice-memory',
    sources: [
      { sourceClass: 'docs', include: ['docs/**/*.md'] },
      {
        sourceClass: 'harness-memory',
        include: ['**/*.md'],
        root: { id: 'memory', path: memoryDir, personal: true },
      },
    ],
  };
  return { root, memoryDir, config };
}

describe('resolveRoots', () => {
  it('rejects a configuration that would fork the sourcePath keyspace', () => {
    const primary = '/tmp/primary';
    expect(() =>
      resolveRoots(primary, [
        { root: { id: 'm', path: '/tmp/a' } },
        { root: { id: 'm', path: '/tmp/b' } },
      ])
    ).toThrow(/two directories/);
    expect(() =>
      resolveRoots(primary, [
        { root: { id: 'a', path: '/tmp/same' } },
        { root: { id: 'b', path: '/tmp/same' } },
      ])
    ).toThrow(/two ids/);
    // A '/' in an id would make the prefix unparseable.
    expect(() => resolveRoots(primary, [{ root: { id: 'a/b', path: '/tmp/x' } }])).toThrow(
      /not a valid root id/
    );
  });

  it('folds a source root that points at the primary directory into the primary', () => {
    const roots = resolveRoots('/tmp/primary', [{ root: { id: 'dup', path: '/tmp/primary' } }]);
    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBeNull();
  });
});

describe('resolveInRoots', () => {
  const roots = resolveRoots('/repo', [
    { root: { id: 'memory', path: '/home/me/.claude/projects/-repo/memory', personal: true } },
  ]);

  it('rejects an escape attempt against the primary root', () => {
    expect(() => resolveInRoots(roots, '../../etc/passwd')).toThrow(/escapes engine root/);
    expect(() => resolveInRoots(roots, 'docs/../../../etc/passwd')).toThrow(
      /escapes engine root/
    );
  });

  it('rejects an escape attempt against the second root', () => {
    // Same traversal, aimed through the prefix rather than the primary root.
    expect(() => resolveInRoots(roots, '@memory/../../../../../etc/passwd')).toThrow(
      /escapes engine root/
    );
    // One level up is still outside the memory root (its sibling projects dir).
    expect(() => resolveInRoots(roots, '@memory/../other-repo/memory/secret.md')).toThrow(
      /escapes engine root/
    );
  });

  it('rejects a path that resolves outside every root even when several exist', () => {
    // /repo-adjacent is a sibling of the primary root — the `+ sep` in the
    // containment test is what stops a shared string prefix from counting.
    expect(() => resolveInRoots(roots, '../repo-adjacent/x.md')).toThrow(
      /escapes engine root/
    );
  });

  it('treats an unrecognized @id as a literal primary path, not an open door', () => {
    // A repo may hold a top-level '@scope/' directory, so the prefix only binds
    // to a CONFIGURED root id. The fallback stays inside the primary root.
    const r = resolveInRoots(roots, '@scope/pkg/README.md');
    expect(r.abs).toBe(path.resolve('/repo/@scope/pkg/README.md'));
    expect(r.sourcePath).toBe('@scope/pkg/README.md');
    expect(() => resolveInRoots(roots, '@nope/../../etc/passwd')).toThrow(
      /escapes engine root/
    );
  });

  it('canonicalizes a sourcePath to the root that actually owns it', () => {
    expect(resolveInRoots(roots, '@memory/a/../b.md').sourcePath).toBe('@memory/b.md');
    expect(resolveInRoots(roots, 'docs/./x.md').sourcePath).toBe('docs/x.md');
    // Reachable across roots by traversal — allowed (it IS inside a configured
    // root) but re-attributed, so it can never masquerade as a primary path.
    expect(
      resolveInRoots(roots, '../home/me/.claude/projects/-repo/memory/page.md').sourcePath
    ).toBe('@memory/page.md');
  });
});

describe('MemoryEngine.readDoc guard', () => {
  it('reads from both roots and round-trips the sourcePath it returns', async () => {
    const { root, memoryDir, config } = setup();
    writeFileSync(path.join(root, 'docs/guide.md'), '# Guide\nprimary root body');
    writeFileSync(path.join(memoryDir, 'page.md'), '# Page\npersonal root body');

    const engine = MemoryEngine.create(config, new FakeEmbedder());
    const primary = await engine.readDoc('docs/guide.md');
    expect(primary.path).toBe('docs/guide.md');
    expect(primary.content).toContain('primary root body');

    const personal = await engine.readDoc('@memory/page.md');
    expect(personal.path).toBe('@memory/page.md');
    expect(personal.content).toContain('personal root body');

    // The path a hit carries is the path read_doc accepts — that round-trip is
    // the whole reason a second root got threaded through instead of being
    // indexed as virtual records.
    expect((await engine.readDoc(personal.path)).content).toBe(personal.content);
    await engine.close();
  });

  it('refuses to read outside the configured roots', async () => {
    const { config } = setup();
    const engine = MemoryEngine.create(config, new FakeEmbedder());
    await expect(engine.readDoc('../../etc/passwd')).rejects.toThrow(/read_doc/);
    await expect(engine.readDoc('@memory/../../../../etc/passwd')).rejects.toThrow(/read_doc/);
    await expect(engine.readDoc('/etc/passwd')).rejects.toThrow(/read_doc/);
    await engine.close();
  });

  it('reports which roots are personal, so an exporter can exclude them', async () => {
    const { memoryDir, config } = setup();
    const engine = MemoryEngine.create(config, new FakeEmbedder());
    expect(engine.personalRoots().map((r) => r.dir)).toEqual([path.resolve(memoryDir)]);
    expect(engine.isPersonalSourcePath('@memory/page.md')).toBe(true);
    expect(engine.isPersonalSourcePath('docs/guide.md')).toBe(false);
    // An unattributable path is treated as personal — never publish what you
    // cannot place.
    expect(engine.isPersonalSourcePath('../../etc/passwd')).toBe(true);
    await engine.close();
  });
});

/**
 * `source_path` is the chunk primary key, so the key format is stamped and a
 * mismatch forces a rebuild rather than a half-migration. Both branches are
 * second-launch behavior: the store already exists when the decision is made.
 */
describe('sourcePath key format stamp', () => {
  /** Seed a store as an earlier launch would have left it. */
  function seedStore(dbPath: string, format: number | null): void {
    const store = new SqliteStore(dbPath);
    store.setEmbedderInfo(new FakeEmbedder().info);
    if (format !== null) store.setSourcePathFormat(format);
    store.upsertChunks([
      {
        id: 'docs/guide.md#0',
        sourcePath: 'docs/guide.md',
        sourceClass: 'docs',
        headingPath: ['Guide'],
        ordinal: 0,
        text: 'body',
        contentHash: 'h',
        denseEmbedding: null,
        sparseTerms: { body: 1 },
        embedderId: 'fake',
        model: 'fake-bow',
        dims: 32,
        updatedAt: 1,
        refType: 'doc-file',
        refId: 'docs/guide.md',
      },
    ]);
    store.close();
  }

  it('stamps a store that predates the stamp without discarding its chunks', async () => {
    const { config } = setup();
    seedStore(config.dbPath, null);

    const engine = MemoryEngine.create(config, new FakeEmbedder());
    // Formats 1 and 2 agree on every path an unstamped store can hold (it has no
    // non-primary roots by construction), so re-embedding the corpus would be
    // pure cost.
    expect(engine.status().chunks).toBe(1);
    await engine.close();

    const reopened = new SqliteStore(config.dbPath);
    expect(reopened.getSourcePathFormat()).toBe(2);
    reopened.close();
  });

  it('rebuilds a store stamped with a different format instead of half-migrating', async () => {
    const { config } = setup();
    seedStore(config.dbPath, 1);

    const engine = MemoryEngine.create(config, new FakeEmbedder());
    expect(engine.status().chunks).toBe(0);
    await engine.close();

    const reopened = new SqliteStore(config.dbPath);
    expect(reopened.getSourcePathFormat()).toBe(2);
    reopened.close();
  });

});
