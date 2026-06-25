import { describe, it, expect } from 'vitest';
import {
  isIndexClientMetadataOnlyUpdateForTest,
  pruneClientMetadataForSyncForTest,
} from '../CollabV3Sync';
import type { SyncedSessionMetadata } from '../types';

// Routing predicate guards against the v0.63.0 regression where metadata-only
// updates were silently re-routed to a wire message (`indexClientMetadataPatch`)
// that neither the Cloudflare collab server nor the iOS client understands.
// Fields in Group B drive cross-device UI (spinner, pending prompt, context
// usage, phase, tags, unread badges) and MUST go through the full `indexUpdate`
// path. Widening this allow-list silently breaks mobile again.

describe('isIndexClientMetadataOnlyUpdate routing predicate', () => {
  const m = <T extends Partial<SyncedSessionMetadata>>(meta: T): T => meta;

  describe('forces full indexUpdate (Group B)', () => {
    it('routes { isExecuting, updatedAt } through indexUpdate', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(m({ isExecuting: false, updatedAt: 123 })),
      ).toBe(false);
    });

    it('routes { hasPendingPrompt, updatedAt } through indexUpdate', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(m({ hasPendingPrompt: true, updatedAt: 123 })),
      ).toBe(false);
    });

    it('routes { currentContext } through indexUpdate', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(
          m({ currentContext: { tokens: 1, contextWindow: 200000 } }),
        ),
      ).toBe(false);
    });

    it('routes { agentStatus } through indexUpdate', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(
          m({ agentStatus: { kind: 'thinking', label: 'Thinking...', updatedAt: 123 } }),
        ),
      ).toBe(false);
    });

    it('routes { phase } through indexUpdate', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(m({ phase: 'validating' } as Partial<SyncedSessionMetadata>)),
      ).toBe(false);
    });

    it('routes { tags } through indexUpdate', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(m({ tags: ['bug-fix'] } as Partial<SyncedSessionMetadata>)),
      ).toBe(false);
    });

    it('routes { lastReadAt } through indexUpdate (cross-device unread badges)', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(m({ lastReadAt: 123 } as Partial<SyncedSessionMetadata>)),
      ).toBe(false);
    });

    it('does not route { draftInput, draftUpdatedAt } through the patch path', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(
          m({ draftInput: 'hello', draftUpdatedAt: 123 } as Partial<SyncedSessionMetadata>),
        ),
      ).toBe(false);
    });
  });

  describe('stays on patch fast-path (Group A)', () => {
    it('routes { hasBeenNamed } through the patch path', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(
          m({ hasBeenNamed: true } as Partial<SyncedSessionMetadata>),
        ),
      ).toBe(true);
    });

    it('routes a bare { updatedAt } through the patch path', () => {
      expect(isIndexClientMetadataOnlyUpdateForTest(m({ updatedAt: 123 }))).toBe(true);
    });
  });

  describe('mixed updates fall back to indexUpdate', () => {
    it('refuses the patch path when any Group B field is mixed with Group A', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(
          m({ isExecuting: false, draftInput: 'x', updatedAt: 123 } as Partial<SyncedSessionMetadata>),
        ),
      ).toBe(false);
    });

    it('refuses the patch path when a non-metadata field is present', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(
          m({ title: 'new title' } as Partial<SyncedSessionMetadata>),
        ),
      ).toBe(false);
    });

    it('refuses the patch path when given an empty update', () => {
      expect(isIndexClientMetadataOnlyUpdateForTest(m({}))).toBe(false);
    });
  });
});

describe('client metadata transcript payload pruning', () => {
  it('keeps a requested history page and drops the tail when combined metadata is too large', () => {
    const metadata = pruneClientMetadataForSyncForTest(
      {
        mobileTranscriptTailJson: 't'.repeat(200_000),
        mobileTranscriptTailUpdatedAt: 1,
        mobileTranscriptHistoryPageJson: 'h'.repeat(200_000),
        mobileTranscriptHistoryPageUpdatedAt: 2,
      },
      'test',
    );

    expect(metadata.mobileTranscriptHistoryPageJson).toBeDefined();
    expect(metadata.mobileTranscriptHistoryPageUpdatedAt).toBe(2);
    expect(metadata.mobileTranscriptTailJson).toBeUndefined();
    expect(metadata.mobileTranscriptTailUpdatedAt).toBeUndefined();
  });

  it('drops a single oversized history page instead of sending it to CollabV3', () => {
    const metadata = pruneClientMetadataForSyncForTest(
      {
        mobileTranscriptHistoryPageJson: 'h'.repeat(300_000),
        mobileTranscriptHistoryPageUpdatedAt: 2,
        agentStatus: { kind: 'idle', label: 'Idle', updatedAt: 3 },
      },
      'test',
    );

    expect(metadata.mobileTranscriptHistoryPageJson).toBeUndefined();
    expect(metadata.mobileTranscriptHistoryPageUpdatedAt).toBeUndefined();
    expect(metadata.agentStatus?.kind).toBe('idle');
  });
});
