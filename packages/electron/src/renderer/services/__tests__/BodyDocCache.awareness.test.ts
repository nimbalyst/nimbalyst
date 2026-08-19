// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwarenessState } from '@nimbalyst/runtime/sync';
import { asTeamJwt, asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

interface FakeProvider {
  destroyed: boolean;
  emitAwareness(states: Map<string, AwarenessState>): void;
}

const h = vi.hoisted(() => ({
  providers: [] as FakeProvider[],
}));

vi.mock('@nimbalyst/runtime/sync', () => {
  class FakeDocumentSyncProvider {
    private readonly awarenessListeners = new Set<
      (states: Map<string, AwarenessState>) => void
    >();
    destroyed = false;

    constructor(readonly config: Record<string, unknown>) {
      h.providers.push(this);
    }

    onAwarenessChange(
      listener: (states: Map<string, AwarenessState>) => void,
    ): () => void {
      this.awarenessListeners.add(listener);
      return () => this.awarenessListeners.delete(listener);
    }

    emitAwareness(states: Map<string, AwarenessState>): void {
      for (const listener of this.awarenessListeners) listener(states);
    }

    destroy(): void {
      this.destroyed = true;
    }
  }

  return {
    DocumentSyncProvider: FakeDocumentSyncProvider,
    CollabLexicalProvider: class {
      constructor(readonly syncProvider: unknown, readonly options?: unknown) {}
    },
  };
});

import {
  BodyDocCache,
  type BodyDocConfigFactory,
} from '../BodyDocCache';

function makeFactory(): BodyDocConfigFactory {
  return async (itemId) => ({
    serverUrl: 'wss://test.invalid',
    getJwt: async () => asTeamJwt('jwt'),
    orgId: 'org-1',
    teamMemberId: asTeamMemberId('user-1'),
    documentId: `tracker-content/${itemId}`,
    createWebSocket: (() => {
      throw new Error('WebSocket construction is not expected in this test');
    }) as unknown as (url: string) => WebSocket,
  });
}

function awareness(name: string, color: string): AwarenessState {
  return { user: { name, color } };
}

beforeEach(() => {
  h.providers.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BodyDocCache awareness fan-out', () => {
  it('fans one provider snapshot to every mount and replays it to late mounts', async () => {
    const cache = new BodyDocCache();
    const snapshotsA: Array<Map<string, AwarenessState>> = [];
    const snapshotsB: Array<Map<string, AwarenessState>> = [];

    const a = await cache.acquire('item-1', makeFactory(), {
      onAwarenessChange: (states) => snapshotsA.push(states),
    });
    const b = await cache.acquire('item-1', makeFactory(), {
      onAwarenessChange: (states) => snapshotsB.push(states),
    });

    expect(h.providers).toHaveLength(1);
    expect(snapshotsA[0].size).toBe(0);
    expect(snapshotsB[0].size).toBe(0);

    h.providers[0].emitAwareness(new Map([
      ['remote-1', awareness('Ada Lovelace', '#123456')],
    ]));
    expect(snapshotsA.at(-1)?.get('remote-1')?.user.name).toBe('Ada Lovelace');
    expect(snapshotsB.at(-1)?.get('remote-1')?.user.color).toBe('#123456');
    expect(snapshotsA.at(-1)).not.toBe(snapshotsB.at(-1));

    a?.release();
    h.providers[0].emitAwareness(new Map([
      ['remote-2', awareness('Grace Hopper', '#abcdef')],
    ]));
    expect(snapshotsA).toHaveLength(2);
    expect(snapshotsB.at(-1)?.has('remote-2')).toBe(true);

    const snapshotsC: Array<Map<string, AwarenessState>> = [];
    const c = await cache.acquire('item-1', makeFactory(), {
      onAwarenessChange: (states) => snapshotsC.push(states),
    });
    expect(snapshotsC).toHaveLength(1);
    expect(snapshotsC[0].get('remote-2')?.user.name).toBe('Grace Hopper');

    b?.release();
    c?.release();
    cache.dispose();
    expect(h.providers[0].destroyed).toBe(true);
  });
});
