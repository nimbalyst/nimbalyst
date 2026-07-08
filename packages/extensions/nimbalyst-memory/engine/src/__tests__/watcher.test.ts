import { describe, it, expect } from 'vitest';
import { globBaseDir, computeWatchScope } from '../indexer/watcher.js';
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
