// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildSyncPayload } from '../SyncedSessionStore';
import { SYNC_RELEVANT_FIELDS } from '../syncableMetadata';

/**
 * Regression lock for the REAL-TIME create/update push path.
 *
 * `buildSyncPayload` projects a create()/updateMetadata() payload down to the
 * `metadata_updated` change that is pushed via `pushChange`. Only fields listed
 * in `SYNC_RELEVANT_FIELDS.columns` survive the projection, so this is the exact
 * point where the meta-agent grouping fields used to be dropped: a freshly
 * created meta agent / spawned child reached the server + phone WITHOUT
 * `agentRole` / `createdBySessionId` (until a later full bulk resync rebuilt the
 * index via `buildSyncedSessionIndexFields`).
 *
 * For a not-yet-cached session the pushed metadata lands in the `newEntry`
 * branch of `CollabV3Sync`, which copies these fields straight onto the wire
 * `SessionIndexEntry`. If they are missing from the payload here, that branch
 * has nothing to forward -- hence this lock sits on the payload builder.
 *
 * null -> undefined normalization of `createdBySessionId` happens downstream in
 * `CollabV3Sync` (newEntry / cached-merge branches), mirroring
 * `buildSyncedSessionIndexFields`; it is locked by sessionIndexEntryFields.test.ts.
 */
describe('SYNC_RELEVANT_FIELDS.columns', () => {
  it('includes the meta-agent grouping fields so the push payload carries them', () => {
    expect(SYNC_RELEVANT_FIELDS.columns).toContain('agentRole');
    expect(SYNC_RELEVANT_FIELDS.columns).toContain('createdBySessionId');
  });

  it('does not treat grouping fields as sort-relevant (no list re-sort on group change)', () => {
    expect(SYNC_RELEVANT_FIELDS.sortRelevantColumns).not.toContain('agentRole');
    expect(SYNC_RELEVANT_FIELDS.sortRelevantColumns).not.toContain('createdBySessionId');
  });
});

describe('buildSyncPayload (create/metadata_updated push payload)', () => {
  it('carries agentRole for a freshly created meta-agent session', () => {
    const metadata = buildSyncPayload(
      { id: 'meta-1', title: 'Meta agent', provider: 'claude-code', agentRole: 'meta-agent' },
      { forceUpdatedAt: true },
    );
    expect(metadata.agentRole).toBe('meta-agent');
  });

  it('carries both grouping fields for a spawned child session', () => {
    const metadata = buildSyncPayload(
      {
        id: 'child-1',
        title: 'Child session',
        provider: 'claude-code',
        agentRole: 'standard',
        createdBySessionId: 'meta-session-123',
      },
      { forceUpdatedAt: true },
    );
    expect(metadata.agentRole).toBe('standard');
    expect(metadata.createdBySessionId).toBe('meta-session-123');
  });

  it('does not fabricate grouping fields for a plain session', () => {
    const metadata = buildSyncPayload(
      { id: 'plain-1', title: 'Plain session', provider: 'claude-code' },
      { forceUpdatedAt: true },
    );
    expect('agentRole' in metadata).toBe(false);
    expect('createdBySessionId' in metadata).toBe(false);
  });

  it('forwards a grouping-only update (e.g. agentRole promotion) without forcing a re-sort', () => {
    const metadata = buildSyncPayload({ agentRole: 'meta-agent' });
    expect(metadata.agentRole).toBe('meta-agent');
    // No sort-relevant column changed, so updatedAt must not be stamped.
    expect('updatedAt' in metadata).toBe(false);
  });
});
