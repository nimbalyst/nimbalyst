import { describe, expect, it } from 'vitest';
import {
  buildFileDirectoryTree,
  getFileDirectoryPaths,
  getFilePathBasename,
  getWorkspaceRelativeFilePath,
} from '../fileDirectoryTree';

interface TestFile {
  filePath: string;
}

const buildTree = (files: string[], workspacePath?: string) =>
  buildFileDirectoryTree<TestFile>(
    files.map(filePath => ({ filePath })),
    file => file.filePath,
    workspacePath,
  );

describe('file path helpers', () => {
  it('normalizes Unix, Windows, and mixed separators', () => {
    expect(getWorkspaceRelativeFilePath('/repo/src/App.tsx', '/repo')).toBe('src/App.tsx');
    expect(getWorkspaceRelativeFilePath('C:\\repo\\src\\App.tsx', 'C:\\repo'))
      .toBe('src/App.tsx');
    expect(getWorkspaceRelativeFilePath('C:\\repo/src\\App.tsx', 'C:\\repo\\'))
      .toBe('src/App.tsx');
  });

  it('compares Windows drive paths case-insensitively', () => {
    expect(getWorkspaceRelativeFilePath('c:\\Repo\\src\\App.tsx', 'C:\\repo'))
      .toBe('src/App.tsx');
  });

  it('does not strip a partial workspace prefix', () => {
    expect(getWorkspaceRelativeFilePath('/repo-copy/src/App.tsx', '/repo'))
      .toBe('/repo-copy/src/App.tsx');
  });

  it('gets basenames from Unix and Windows paths', () => {
    expect(getFilePathBasename('packages/runtime/index.ts')).toBe('index.ts');
    expect(getFilePathBasename('packages\\runtime\\index.ts')).toBe('index.ts');
  });

  it('gets directory names from paths with trailing separators', () => {
    expect(getFilePathBasename('docs/')).toBe('docs');
    expect(getFilePathBasename('packages\\runtime\\')).toBe('runtime');
  });
});

describe('buildFileDirectoryTree', () => {
  it('groups Windows files with duplicate basenames under their directories', () => {
    const tree = buildTree([
      'C:\\repo\\skills\\one\\SKILL.md',
      'C:\\repo\\skills\\two\\SKILL.md',
      'C:\\repo\\README.md',
    ], 'C:\\repo');

    expect(tree.displayPath).toBe('');
    expect(tree.files.map(file => file.filePath)).toEqual(['C:\\repo\\README.md']);
    expect([...tree.subdirectories.keys()]).toEqual(['skills']);
    expect(getFileDirectoryPaths(tree)).toEqual(['skills', 'skills/one', 'skills/two']);
    expect(tree.fileCount).toBe(3);
    expect(tree.subdirectories.get('skills')?.fileCount).toBe(2);
  });

  it('groups workspace-relative Windows paths for commit proposals', () => {
    const tree = buildTree([
      'packages\\runtime\\SKILL.md',
      'packages\\electron\\SKILL.md',
    ]);

    expect(tree.displayPath).toBe('packages');
    expect(getFileDirectoryPaths(tree)).toEqual(['packages', 'packages/runtime', 'packages/electron']);
  });

  it('collapses a single-child Unix directory chain', () => {
    const tree = buildTree(['/repo/packages/runtime/src/index.ts'], '/repo');

    expect(tree.displayPath).toBe('packages/runtime/src');
    expect(tree.path).toBe('packages/runtime/src');
    expect(tree.fileCount).toBe(1);
    expect(tree.files).toHaveLength(1);
  });
});
