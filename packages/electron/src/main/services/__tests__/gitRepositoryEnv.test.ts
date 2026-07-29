import { describe, expect, it } from 'vitest';
import { sanitizeGitRepositoryEnv } from '../gitRepositoryEnv';

describe('sanitizeGitRepositoryEnv', () => {
  it('removes repository redirects while preserving user-facing Git behavior', () => {
    expect(sanitizeGitRepositoryEnv({
      PATH: '/test/bin',
      GIT_ASKPASS: '/test/askpass',
      GIT_EDITOR: 'vim',
      GIT_SSH_COMMAND: 'ssh -i test-key',
      GIT_DIR: '/real/repo/.git',
      GIT_WORK_TREE: '/real/repo',
      GIT_INDEX_FILE: '/real/repo/.git/index',
      GIT_COMMON_DIR: '/real/repo/.git',
      GIT_OBJECT_DIRECTORY: '/real/repo/.git/objects',
      GIT_NAMESPACE: 'escaped-fixture',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.bare',
      GIT_CONFIG_VALUE_0: 'true',
    })).toEqual({
      PATH: '/test/bin',
      GIT_ASKPASS: '/test/askpass',
      GIT_EDITOR: 'vim',
      GIT_SSH_COMMAND: 'ssh -i test-key',
    });
  });
});
