// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bodyWriteFailure } from '../trackerToolResult';

describe('bodyWriteFailure', () => {
  it('marks a server-managed custody failure as non-retryable', () => {
    const result = bodyWriteFailure(true, {
      code: 'key_custody_unavailable',
      message: 'Server-managed key custody is unavailable for this organization',
    });

    expect(result).toMatchObject({
      status: 'failed',
      collaborativeBodyStored: false,
      diagnostic: {
        code: 'key_custody_unavailable',
        retryable: false,
      },
    });
    expect(result.message).toContain('server-managed key custody');
    expect(result.message).not.toContain('Retry the body write');
  });

  it('does not claim a local snapshot was saved when custody prevented that write', () => {
    const result = bodyWriteFailure(false, {
      code: 'key_custody_unavailable',
      message: 'transport-private-detail',
    });
    expect(result.localSnapshotStored).toBe(false);
    expect(result.diagnostic).toEqual({ code: 'key_custody_unavailable', retryable: false });
    expect(result.message).toContain('did not complete locally');
    expect(result.message).not.toContain('local body snapshot were saved');
    expect(result.message).not.toContain('transport-private-detail');
  });

  it('keeps unknown server diagnostics out of the public failure message', () => {
    const result = bodyWriteFailure(true, {
      code: 'unknown_server_code',
      message: 'transport-private-detail',
    });
    expect(result.diagnostic).toBeUndefined();
    expect(result.message).toContain('Retry the body write');
    expect(result.message).not.toContain('unknown_server_code');
    expect(result.message).not.toContain('transport-private-detail');
  });
});
