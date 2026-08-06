import { describe, expect, it } from 'vitest';
import path from 'path';
import { resolveTargetWorkspaceBinding } from '../targetWorkspaceBinding';

describe('resolveTargetWorkspaceBinding', () => {
  it('keeps target-session operations bound to the caller workspace by default', () => {
    expect(resolveTargetWorkspaceBinding('/projects/caller')).toBe(path.normalize('/projects/caller'));
  });

  it('uses an explicitly supplied target workspace', () => {
    expect(
      resolveTargetWorkspaceBinding('/projects/caller', {
        targetWorkspacePath: '/projects/target',
      }),
    ).toBe(path.normalize('/projects/target'));
  });

  it.each([null, '', '   ', 42, 'projects/target'])(
    'fails closed for an invalid explicit target workspace (%p)',
    (targetWorkspacePath) => {
      expect(() =>
        resolveTargetWorkspaceBinding('/projects/caller', { targetWorkspacePath }),
      ).toThrow(/targetWorkspacePath/);
    },
  );
});
