import { describe, expect, it } from 'vitest';
import {
  ATTENTION_SUPERVISOR_METADATA_KEY,
  assertNoReservedAttentionSupervisorMetadataMutation,
} from '../AttentionSupervisorAuthorization';

describe('reserved attention-supervisor metadata guard', () => {
  it.each([
    [{ [ATTENTION_SUPERVISOR_METADATA_KEY]: ['supervisor-a'] }, 'direct set'],
    [{ metadata: { [ATTENTION_SUPERVISOR_METADATA_KEY]: [] } }, 'nested replace'],
    [{ metadata: { deeper: [{ [ATTENTION_SUPERVISOR_METADATA_KEY]: null }] } }, 'nested remove'],
    [{ patch: { [ATTENTION_SUPERVISOR_METADATA_KEY]: undefined } }, 'undefined remove'],
  ])('rejects a %s attempt before a generic metadata route can write', (candidate, _label) => {
    expect(() => assertNoReservedAttentionSupervisorMetadataMutation(
      candidate,
      'test:generic-metadata-route',
    )).toThrow(/reserved.*dedicated/i);
  });

  it('allows ordinary metadata, including nested arrays and objects', () => {
    expect(() => assertNoReservedAttentionSupervisorMetadataMutation(
      {
        phase: 'validating',
        metadata: {
          tags: ['nim-362'],
          nested: [{ hasUnread: false }],
        },
      },
      'test:generic-metadata-route',
    )).not.toThrow();
  });
});
