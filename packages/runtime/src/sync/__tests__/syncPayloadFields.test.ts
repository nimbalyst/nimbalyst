// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildSyncPayload } from '../SyncedSessionStore';
import { SYNC_RELEVANT_FIELDS } from '../syncableMetadata';

const EXPECTED_OPAQUE_CLIENT_METADATA_FIELDS = [
  'currentContext',
  'hasPendingPrompt',
  'attentionSummary',
  'phase',
  'tags',
  'draftInput',
  'draftUpdatedAt',
  'hasBeenNamed',
] as const;

function requiredMatch(source: string, pattern: RegExp, description: string): string {
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`Could not locate ${description}`);
  return match[1];
}

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`Could not locate source range ${startMarker} -> ${endMarker}`);
  }
  return source.slice(start, end);
}

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

describe('SYNC_RELEVANT_FIELDS.metadataKeys', () => {
  it('projects the bounded attention summary into encrypted client metadata sync', () => {
    expect(SYNC_RELEVANT_FIELDS.metadataKeys).toContain('attentionSummary');
  });
});

describe('opaque client metadata field parity', () => {
  const runtimeSource = readFileSync(new URL('../CollabV3Sync.ts', import.meta.url), 'utf8');
  const iosProtocolSource = readFileSync(
    new URL('../../../../ios/NimbalystNative/Sources/Sync/SyncProtocol.swift', import.meta.url),
    'utf8',
  );
  const iosSyncManagerSource = readFileSync(
    new URL('../../../../ios/NimbalystNative/Sources/Sync/SyncManager.swift', import.meta.url),
    'utf8',
  );

  it('keeps the complete eight-field runtime shape in the iOS wire model and whole-blob draft builder', () => {
    const runtimeInterface = requiredMatch(
      runtimeSource,
      /export interface ClientMetadata \{([\s\S]*?)\n\}/,
      'runtime ClientMetadata interface',
    );
    const runtimeFields = [...runtimeInterface.matchAll(/^  (\w+)\??:/gm)].map((match) => match[1]);

    const iosStruct = requiredMatch(
      iosProtocolSource,
      /struct ClientMetadata: Codable \{([\s\S]*?)\n\}/,
      'iOS ClientMetadata struct',
    );
    const iosFields = [...iosStruct.matchAll(/^    let (\w+):/gm)].map((match) => match[1]);

    const preservationInitializer = requiredMatch(
      iosProtocolSource,
      /static func preservingOpaqueState\([\s\S]*?return ClientMetadata\(([\s\S]*?)\n        \)\n    \}/,
      'iOS preservingOpaqueState initializer',
    );
    const preservedFields = [...preservationInitializer.matchAll(/^            (\w+):/gm)]
      .map((match) => match[1]);

    expect(runtimeFields).toEqual(EXPECTED_OPAQUE_CLIENT_METADATA_FIELDS);
    expect(iosFields).toEqual(EXPECTED_OPAQUE_CLIENT_METADATA_FIELDS);
    expect(preservedFields).toEqual(EXPECTED_OPAQUE_CLIENT_METADATA_FIELDS);
  });

  it('recognizes every opaque field as a runtime metadata whole-blob writer trigger', () => {
    const writerGuard = requiredMatch(
      runtimeSource,
      /const hasClientMetaFields = ([\s\S]*?);\r?\n          if \(hasClientMetaFields/,
      'Runtime metadata writer guard',
    );

    for (const field of EXPECTED_OPAQUE_CLIENT_METADATA_FIELDS) {
      expect(writerGuard).toContain(`'${field}' in change.metadata`);
    }
  });

  it('reconciles the naming marker on full sync, index broadcasts, and metadata broadcasts', () => {
    const backgroundFullSync = sourceBetween(
      iosSyncManagerSource,
      'private nonisolated static func processServerSessionBackground',
      '    private func processServerProject(',
    );
    const foregroundIndexBroadcast = sourceBetween(
      iosSyncManagerSource,
      'private func processServerSessionWithResult',
      '    /// Decrypt queued prompts',
    );
    const metadataBroadcast = sourceBetween(
      iosSyncManagerSource,
      'private func handleMetadataBroadcast',
      '    private func decryptServerMessage',
    );

    for (const inboundPath of [backgroundFullSync, foregroundIndexBroadcast, metadataBroadcast]) {
      expect(inboundPath).toContain('SessionOpaqueMetadataReconciler.namingMarker');
    }
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
