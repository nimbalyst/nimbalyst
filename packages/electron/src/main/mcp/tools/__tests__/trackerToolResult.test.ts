// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { bodyWriteFailure } from '../trackerToolResult';

describe('bodyWriteFailure', () => {
  it('marks a server-managed custody failure as non-retryable', () => {
    const result = (bodyWriteFailure as unknown as (
      localSnapshotStored: boolean,
      diagnostic?: { code: string; message: string },
    ) => any)(true, {
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
});
