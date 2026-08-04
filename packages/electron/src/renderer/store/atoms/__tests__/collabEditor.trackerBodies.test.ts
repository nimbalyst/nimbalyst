// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deriveCollabProductStatus } from '../collabEditor';

describe('deriveCollabProductStatus for transport-only tracker bodies', () => {
  it('derives connected, connecting, and replaying without a replica state', () => {
    expect(deriveCollabProductStatus({
      transport: 'connected',
      outbox: 'clean',
    })).toMatchObject({
      kind: 'synced',
      showPresence: true,
    });
    expect(deriveCollabProductStatus({
      transport: 'connecting',
      outbox: 'clean',
    })).toMatchObject({
      kind: 'connecting',
      showPresence: false,
    });
    expect(deriveCollabProductStatus({
      transport: 'replaying',
      outbox: 'replaying',
    })).toMatchObject({
      kind: 'replaying',
      showPresence: false,
    });
  });

  it('does not claim a transport-only tracker body has a durable local copy', () => {
    const status = deriveCollabProductStatus({
      transport: 'offline-unsynced',
      outbox: 'pending',
    });

    expect(status.kind).toBe('offline-safe');
    expect(status.label).toBe('Offline');
    expect(status.detail).toContain('Reconnect');
    expect(`${status.label} ${status.detail}`).not.toContain('saved locally');
    expect(`${status.label} ${status.detail}`).not.toContain('saved on this device');
  });
});
