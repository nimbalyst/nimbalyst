import { describe, expect, it } from 'vitest';
import {
  compareFilesByBasename,
  compareSubdirectoriesByDisplayPath,
  type DirectoryNode,
} from '../CustomToolWidgets/GitCommitConfirmationWidget';

function makeNode(displayPath: string): DirectoryNode {
  return {
    path: displayPath,
    displayPath,
    files: [],
    subdirectories: new Map(),
    fileCount: 0,
  };
}

describe('compareFilesByBasename', () => {
  it('sorts paths alphabetically by their basename (issue #233 example)', () => {
    const modelOrder = [
      '.claude/commands/analyze-code.md',
      '.claude/commands/roadmap.md',
      '.claude/commands/bug-report.md',
      '.claude/commands/design.md',
      '.claude/commands/posthog-analysis.md',
    ];
    expect(modelOrder.slice().sort(compareFilesByBasename)).toEqual([
      '.claude/commands/analyze-code.md',
      '.claude/commands/bug-report.md',
      '.claude/commands/design.md',
      '.claude/commands/posthog-analysis.md',
      '.claude/commands/roadmap.md',
    ]);
  });

  it('sorts by basename only, not by full path', () => {
    const files = [
      'deep/nested/path/zebra.ts',
      'shallow/apple.ts',
    ];
    expect(files.slice().sort(compareFilesByBasename)).toEqual([
      'shallow/apple.ts',
      'deep/nested/path/zebra.ts',
    ]);
  });

  it('handles paths without directory separators', () => {
    const files = ['z.md', 'a.md', 'm.md'];
    expect(files.slice().sort(compareFilesByBasename)).toEqual(['a.md', 'm.md', 'z.md']);
  });

  it('sorts Windows paths by basename', () => {
    const files = ['deep\\zebra.ts', 'shallow\\apple.ts'];
    expect(files.slice().sort(compareFilesByBasename)).toEqual([
      'shallow\\apple.ts',
      'deep\\zebra.ts',
    ]);
  });

  it('is stable across already-sorted input', () => {
    const files = ['a.md', 'b.md', 'c.md'];
    expect(files.slice().sort(compareFilesByBasename)).toEqual(['a.md', 'b.md', 'c.md']);
  });
});

describe('compareSubdirectoriesByDisplayPath', () => {
  it('sorts nodes alphabetically by displayPath', () => {
    const nodes = [makeNode('utils'), makeNode('api'), makeNode('components')];
    expect(
      nodes
        .slice()
        .sort(compareSubdirectoriesByDisplayPath)
        .map((n) => n.displayPath),
    ).toEqual(['api', 'components', 'utils']);
  });

  it('handles collapsed compound displayPaths', () => {
    const nodes = [
      makeNode('packages/runtime/src'),
      makeNode('packages/electron/src/components'),
      makeNode('docs'),
    ];
    expect(
      nodes
        .slice()
        .sort(compareSubdirectoriesByDisplayPath)
        .map((n) => n.displayPath),
    ).toEqual([
      'docs',
      'packages/electron/src/components',
      'packages/runtime/src',
    ]);
  });
});
