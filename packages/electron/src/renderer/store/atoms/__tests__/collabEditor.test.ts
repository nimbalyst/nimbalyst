import { describe, expect, it } from 'vitest';
import type {
  DocumentSyncStatus,
  LocalDocumentReplicaOutboxState,
  LocalDocumentReplicaState,
} from '@nimbalyst/runtime/sync';
import {
  deriveCollabProductStatus,
  deriveLegacyDocumentSyncStatus,
  type CollabProductStatusKind,
} from '../collabEditor';

const replicas: LocalDocumentReplicaState[] = [
  'loading',
  'ready',
  'corrupt',
  'unavailable',
];
const transports: DocumentSyncStatus[] = [
  'disconnected',
  'connecting',
  'syncing',
  'replaying',
  'offline-unsynced',
  'connected',
  'error',
];
const outboxes: LocalDocumentReplicaOutboxState[] = [
  'clean',
  'pending',
  'replaying',
  'rejected',
];

describe('deriveCollabProductStatus', () => {
  const combinations = replicas.flatMap((replica) =>
    transports.flatMap((transport) =>
      outboxes.map((outbox) => ({ replica, transport, outbox })),
    ),
  );

  it('returns a complete product status for every replica × transport × outbox combination', () => {
    expect(combinations).toHaveLength(112);
    for (const state of combinations) {
      const status = deriveCollabProductStatus(state);
      expect(status.kind).toBeTruthy();
      expect(status.label).toBeTruthy();
      expect(status.showRejectedActions).toBe(state.outbox === 'rejected');
    }
  });

  const precedenceCases: Array<[
    LocalDocumentReplicaState,
    DocumentSyncStatus,
    LocalDocumentReplicaOutboxState,
    CollabProductStatusKind,
  ]> = [
    ['loading', 'connected', 'clean', 'opening-local-copy'],
    ['corrupt', 'connected', 'rejected', 'local-copy-damaged'],
    ['unavailable', 'connected', 'rejected', 'local-saving-unavailable'],
    ['ready', 'connected', 'rejected', 'access-changed'],
    ['ready', 'disconnected', 'replaying', 'replaying'],
    ['ready', 'replaying', 'clean', 'replaying'],
    // connected+pending is in-flight typing, not an offline backlog -- it
    // must read as synced or the pill flashes on every keystroke.
    ['ready', 'connected', 'pending', 'synced'],
    ['ready', 'connected', 'clean', 'synced'],
    ['ready', 'connecting', 'clean', 'connecting'],
    ['ready', 'syncing', 'clean', 'connecting'],
    ['ready', 'disconnected', 'pending', 'offline-safe'],
    ['ready', 'error', 'clean', 'offline-safe'],
  ];

  it.each(precedenceCases)(
    'maps replica=%s transport=%s outbox=%s to %s',
    (replica, transport, outbox, expected) => {
      expect(deriveCollabProductStatus({ replica, transport, outbox }).kind).toBe(expected);
    },
  );

  it('uses the product-approved primary copy', () => {
    const cases: Array<[CollabProductStatusKind, string]> = [
      ['opening-local-copy', 'Opening local copy…'],
      ['connecting', 'Connecting…'],
      ['synced', 'Synced'],
      ['offline-safe', 'Offline — changes saved on this device'],
      ['replaying', 'Syncing offline changes…'],
      ['access-changed', 'Access changed — local edits have not been uploaded'],
      ['local-copy-damaged', 'Local copy damaged — downloading a clean copy'],
      ['local-saving-unavailable', 'Changes are not saved locally'],
    ];
    for (const [kind, label] of cases) {
      const match = combinations.find(
        (state) => deriveCollabProductStatus(state).kind === kind,
      );
      expect(match, `missing state for ${kind}`).toBeDefined();
      expect(deriveCollabProductStatus(match!).label).toBe(label);
    }
  });

  it('only exposes presence for a connected usable replica', () => {
    for (const state of combinations) {
      const status = deriveCollabProductStatus(state);
      if (status.showPresence) {
        expect(state.transport).toBe('connected');
        expect(state.replica).not.toBe('loading');
        expect(state.replica).not.toBe('corrupt');
      }
    }
  });

  it('reports device-local multi-window convergence in the offline-safe detail', () => {
    const offline = deriveCollabProductStatus({
      replica: 'ready',
      transport: 'disconnected',
      outbox: 'pending',
    });
    expect(offline.detail).toContain('other open windows');
  });

  it('keeps rejected recovery actions visible when persistence is unavailable', () => {
    const status = deriveCollabProductStatus({
      replica: 'unavailable',
      transport: 'disconnected',
      outbox: 'rejected',
    });
    expect(status.kind).toBe('local-saving-unavailable');
    expect(status.showRejectedActions).toBe(true);
  });

  it('keeps the legacy single status honest about durable outbox work', () => {
    expect(deriveLegacyDocumentSyncStatus({
      replica: 'ready',
      transport: 'connected',
      outbox: 'pending',
    })).toBe('replaying');
    expect(deriveLegacyDocumentSyncStatus({
      replica: 'ready',
      transport: 'connected',
      outbox: 'rejected',
    })).toBe('offline-unsynced');
  });
});
