import { describe, expect, it } from 'vitest';
import {
  GH_WORKFLOW_SCOPE_REFRESH_COMMAND,
  getGhApiEndpoint,
  getWorkflowScopeRecoveryMessage,
} from '../GhApiService';

describe('getGhApiEndpoint', () => {
  it('returns a read endpoint in the usual position', () => {
    expect(getGhApiEndpoint(['api', 'repos/nimbalyst/nimbalyst'])).toBe(
      'repos/nimbalyst/nimbalyst',
    );
  });

  it('skips mutation method flags before the endpoint', () => {
    expect(
      getGhApiEndpoint([
        'api',
        '-X',
        'PUT',
        'repos/nimbalyst/nimbalyst/pulls/792/merge',
        '-f',
        'merge_method=squash',
      ]),
    ).toBe('repos/nimbalyst/nimbalyst/pulls/792/merge');
  });
});

describe('getWorkflowScopeRecoveryMessage', () => {
  it('turns the workflow OAuth failure into actionable guidance', () => {
    const stderr =
      'gh: refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope (HTTP 403)';
    const message = getWorkflowScopeRecoveryMessage(stderr);

    expect(message).toContain('PR changes a workflow file');
    expect(message).toContain(GH_WORKFLOW_SCOPE_REFRESH_COMMAND);
  });

  it('ignores unrelated GitHub failures', () => {
    expect(
      getWorkflowScopeRecoveryMessage('gh: Pull Request is not mergeable (HTTP 405)'),
    ).toBeNull();
  });
});
