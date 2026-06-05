import { describe, expect, it } from 'vitest';
import { resolveTranscriptClickPath } from '../resolveTranscriptClickPath';

describe('resolveTranscriptClickPath', () => {
  const base = '/Users/me/project';

  it('joins a workspace-relative path against the base dir', () => {
    expect(resolveTranscriptClickPath('nimbalyst-local/plans/foo.md', base)).toBe(
      '/Users/me/project/nimbalyst-local/plans/foo.md',
    );
  });

  it('resolves against the worktree path when that is the base', () => {
    expect(
      resolveTranscriptClickPath('src/a/foo.ts', '/Users/me/project_worktrees/jade-spark'),
    ).toBe('/Users/me/project_worktrees/jade-spark/src/a/foo.ts');
  });

  it('leaves POSIX absolute paths unchanged', () => {
    expect(resolveTranscriptClickPath('/Users/me/project/src/foo.ts', base)).toBe(
      '/Users/me/project/src/foo.ts',
    );
  });

  it('leaves Windows absolute paths unchanged', () => {
    expect(resolveTranscriptClickPath('C:\\proj\\foo.ts', 'C:\\proj')).toBe('C:\\proj\\foo.ts');
    expect(resolveTranscriptClickPath('C:/proj/foo.ts', 'C:/proj')).toBe('C:/proj/foo.ts');
  });

  it('leaves UNC absolute paths unchanged', () => {
    expect(resolveTranscriptClickPath('\\\\server\\share\\foo.ts', base)).toBe(
      '\\\\server\\share\\foo.ts',
    );
  });

  it('trims a trailing separator on the base dir', () => {
    expect(resolveTranscriptClickPath('src/foo.ts', '/Users/me/project/')).toBe(
      '/Users/me/project/src/foo.ts',
    );
  });

  it('returns the path unchanged when no base dir is available', () => {
    expect(resolveTranscriptClickPath('src/foo.ts', undefined)).toBe('src/foo.ts');
  });
});
