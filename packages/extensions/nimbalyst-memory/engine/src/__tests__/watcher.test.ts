// @vitest-environment node
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { globBaseDir, computeWatchScope, computeWatchScopes } from '../indexer/watcher.js';
import { resolveRoots } from '../roots.js';
import type { SourceSet } from '../types.js';

describe('globBaseDir', () => {
  it('returns the static directory prefix before the first glob magic char', () => {
    expect(globBaseDir('design/**/*.md')).toBe('design');
    expect(globBaseDir('nimbalyst-local/plans/**/*.md')).toBe('nimbalyst-local/plans');
    expect(globBaseDir('docs/*.md')).toBe('docs');
  });

  it('returns empty string for root-anchored globs (no leading dir)', () => {
    expect(globBaseDir('CLAUDE.md')).toBe('');
    expect(globBaseDir('**/CLAUDE.md')).toBe('');
  });
});

describe('computeWatchScope', () => {
  const sources: SourceSet[] = [
    { sourceClass: 'design', include: ['design/**/*.md'] },
    { sourceClass: 'docs', include: ['docs/**/*.md'] },
    { sourceClass: 'plans', include: ['nimbalyst-local/plans/**/*.md'] },
    { sourceClass: 'claude', include: ['CLAUDE.md', '**/CLAUDE.md'] },
    { sourceClass: 'facts', include: ['nimbalyst-local/voice-memory/**/*.md'] },
  ];

  it('scopes watch dirs to the source bases — never the workspace root', () => {
    const { dirs } = computeWatchScope(sources);
    // The dirs are the small source trees, not '' (root) — the bug was watching
    // the entire monorepo (100k+ files → EMFILE → fetch socket starvation).
    expect(dirs).toContain('design');
    expect(dirs).toContain('docs');
    expect(dirs).toContain('nimbalyst-local/plans');
    expect(dirs).toContain('nimbalyst-local/voice-memory');
    expect(dirs).not.toContain('');
  });

  it('collects root-anchored globs separately (watched as individual files)', () => {
    const { rootAnchoredGlobs } = computeWatchScope(sources);
    expect(rootAnchoredGlobs).toContain('CLAUDE.md');
    expect(rootAnchoredGlobs).toContain('**/CLAUDE.md');
  });

  it('drops a dir that is a descendant of another watched dir', () => {
    const { dirs } = computeWatchScope([
      { sourceClass: 'a', include: ['nimbalyst-local/**/*.md'] },
      { sourceClass: 'b', include: ['nimbalyst-local/plans/**/*.md'] },
    ]);
    expect(dirs).toEqual(['nimbalyst-local']);
  });
});

describe('computeWatchScopes', () => {
  const multiRoot: SourceSet[] = [
    { sourceClass: 'docs', include: ['docs/**/*.md'] },
    { sourceClass: 'claude', include: ['CLAUDE.md'] },
    {
      sourceClass: 'harness-memory',
      include: ['**/*.md'],
      root: { id: 'memory', path: '/home/me/.claude/projects/-repo/memory', personal: true },
    },
  ];
  const roots = resolveRoots('/repo', multiRoot);

  it('groups sets by root so a base dir is never resolved against the wrong root', () => {
    const scopes = computeWatchScopes(multiRoot, roots);
    expect(scopes).toHaveLength(2);
    const primary = scopes.find((s) => s.root.id === null)!;
    expect(primary.root.dir).toBe(path.resolve('/repo'));
    expect(primary.dirs).toEqual(['docs']);
    // Root-anchored globs on the monorepo root stay file-enumerated — watching
    // that tree recursively is the EMFILE bug.
    expect(primary.rootAnchoredGlobs).toEqual(['CLAUDE.md']);
  });

  it('watches a declared non-primary root recursively rather than snapshotting files', () => {
    const memory = computeWatchScopes(multiRoot, roots).find((s) => s.root.id === 'memory')!;
    // '' is the root itself: a new memory page is picked up without a restart,
    // which file-enumerating '**/*.md' once at startup would not do.
    expect(memory.dirs).toEqual(['']);
    expect(memory.rootAnchoredGlobs).toEqual([]);
  });

  it('keeps a non-primary root with real base dirs scoped to those dirs', () => {
    const sets: SourceSet[] = [
      {
        sourceClass: 'notes',
        include: ['notes/**/*.md'],
        root: { id: 'ext', path: '/elsewhere' },
      },
    ];
    const scopes = computeWatchScopes(sets, resolveRoots('/repo', sets));
    const ext = scopes.find((s) => s.root.id === 'ext')!;
    expect(ext.dirs).toEqual(['notes']);
  });
});
