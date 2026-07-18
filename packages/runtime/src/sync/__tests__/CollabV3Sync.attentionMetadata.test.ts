import { describe, expect, it } from 'vitest';
import {
  buildClientMetadataFromCacheEntryForTest,
  buildClientMetadataFromRawForTest,
  parseClientMetadataForTest,
  serializeClientMetadataForTest,
} from '../CollabV3Sync';

describe('CollabV3 encrypted attention client metadata', () => {
  it('round-trips the bounded summary through the production serializer and cache shape', () => {
    const attentionSummary = {
      pending: true as const,
      severity: 'critical' as const,
      eventId: 'event-1',
      effectiveDeadline: '2026-07-18T12:00:00.000Z',
    };
    const cacheMetadata = buildClientMetadataFromCacheEntryForTest({
      attentionSummary,
    });

    expect(cacheMetadata).toBeDefined();
    const decoded = parseClientMetadataForTest(
      serializeClientMetadataForTest(cacheMetadata!),
    );
    expect(decoded.attentionSummary).toEqual(attentionSummary);
  });

  it('projects raw session metadata without leaking prompt bodies or errors', () => {
    const metadata = buildClientMetadataFromRawForTest({
      attentionSummary: {
        pending: true,
        severity: 'normal',
        eventId: 'event-2',
        effectiveDeadline: '2026-07-18T13:00:00Z',
        body: 'secret question text',
        error: 'raw provider failure',
      },
    });

    expect(metadata?.attentionSummary).toEqual({
      pending: true,
      severity: 'normal',
      eventId: 'event-2',
      effectiveDeadline: '2026-07-18T13:00:00.000Z',
    });
    expect(JSON.stringify(metadata)).not.toContain('secret question text');
    expect(JSON.stringify(metadata)).not.toContain('raw provider failure');
  });

  it('round-trips an explicit cancellation summary', () => {
    const metadata = buildClientMetadataFromRawForTest({
      attentionSummary: { pending: false },
    });
    expect(parseClientMetadataForTest(serializeClientMetadataForTest(metadata!)))
      .toMatchObject({ attentionSummary: { pending: false } });
  });

  it('preserves a timestamp-only opaque field through raw and cache builders', () => {
    expect(buildClientMetadataFromRawForTest({ draftUpdatedAt: 1234 }))
      .toEqual({ draftUpdatedAt: 1234 });
    expect(buildClientMetadataFromCacheEntryForTest({ draftUpdatedAt: 5678 }))
      .toEqual({ draftUpdatedAt: 5678 });
  });
});
