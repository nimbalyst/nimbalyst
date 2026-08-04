// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import type { AwarenessState } from '@nimbalyst/runtime/sync/documentSyncTypes';
import {
  CollabPresenceSurface,
  resolveCollabEditorUser,
} from '../presence';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

class FakeAwarenessSurface {
  readonly document = new Y.Doc();
  readonly localStates: AwarenessState[] = [];
  readonly sentStates: AwarenessState[] = [];
  readonly departures: AwarenessState['user'][] = [];
  private listener: ((states: Map<string, AwarenessState>) => void) | null = null;

  getYDoc(): Y.Doc {
    return this.document;
  }

  getStatus() {
    return 'connected' as const;
  }

  async connect(): Promise<void> {}

  setLocalAwareness(state: AwarenessState): void {
    this.localStates.push(state);
  }

  async sendAwareness(state: AwarenessState): Promise<void> {
    this.sentStates.push(state);
  }

  sendAwarenessDeparture(user: AwarenessState['user']): boolean {
    this.departures.push(user);
    return true;
  }

  onAwarenessChange(listener: (states: Map<string, AwarenessState>) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  emit(states: Map<string, AwarenessState>): void {
    this.listener?.(states);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('collaboration presence surface', () => {
  it('uses the desktop roster precedence for a stable participant identity', () => {
    const memberId = asTeamMemberId('member-1');
    expect(resolveCollabEditorUser({
      memberId,
      name: '  Rowan Petrie  ',
      email: 'rowan@example.com',
      role: 'member',
    })).toMatchObject({ memberId, displayName: 'Rowan Petrie', role: 'member' });
    expect(resolveCollabEditorUser({
      memberId,
      name: ' ',
      email: 'rowan@example.com',
    }).displayName).toBe('rowan@example.com');
    expect(resolveCollabEditorUser({ memberId }).displayName).toBe('member-1');
  });

  it('keeps active clients alive and removes a disconnected bundle participant', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const delegate = new FakeAwarenessSurface();
    const surface = new CollabPresenceSurface(delegate, {
      heartbeatIntervalMs: 1_000,
      staleAfterMs: 2_500,
      sweepIntervalMs: 250,
    });
    const presenceSnapshots: string[][] = [];
    const lexicalSnapshots: number[] = [];
    surface.onPresenceChange((presence) => {
      presenceSnapshots.push(presence.participants.map((participant) => participant.displayName));
    });
    surface.onAwarenessChange((states) => lexicalSnapshots.push(states.size));

    surface.setLocalAwareness({
      user: { name: 'Local Member', color: '#3366ff' },
    });
    expect(delegate.localStates[0].user.nimbalystPresence).toMatchObject({
      version: 1,
      updatedAt: 10_000,
    });

    delegate.emit(new Map([[
      'member-remote',
      {
        user: {
          name: 'Remote Member',
          color: '#16A34A',
          nimbalystPresence: { version: 1, updatedAt: 10_000 },
        },
        cursor: { anchor: '{}', head: '{}' },
      },
    ]]));
    expect(surface.getPresence().participants).toEqual([{
      memberId: 'member-remote',
      displayName: 'Remote Member',
      cursorColor: '#16A34A',
      hasSelection: true,
    }]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(delegate.sentStates).toHaveLength(1);
    expect(delegate.sentStates[0].user.nimbalystPresence).toMatchObject({
      version: 1,
      updatedAt: 11_000,
    });

    await vi.advanceTimersByTimeAsync(1_750);
    expect(surface.getPresence().participants).toEqual([]);
    expect(presenceSnapshots.at(-1)).toEqual([]);
    expect(lexicalSnapshots.at(-1)).toBe(0);
    surface.destroy();
  });

  it('leaves immediately when inactive, suppresses heartbeats, and rejoins when active', async () => {
    vi.useFakeTimers();
    const delegate = new FakeAwarenessSurface();
    const surface = new CollabPresenceSurface(delegate, { heartbeatIntervalMs: 1_000 });
    const localState: AwarenessState = {
      user: { name: 'Local Member', color: '#3366ff' },
    };
    surface.setLocalAwareness(localState);

    expect(surface.setActive(false)).toBe(true);
    expect(delegate.departures).toEqual([localState.user]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(delegate.sentStates).toEqual([]);

    surface.setLocalAwareness({
      ...localState,
      cursor: { anchor: '{}', head: '{}' },
    });
    expect(delegate.localStates).toHaveLength(1);

    surface.setActive(true);
    expect(delegate.sentStates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delegate.sentStates).toHaveLength(2);
    surface.destroy();
  });

  it('does not expire an idle legacy desktop peer without heartbeat metadata', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const delegate = new FakeAwarenessSurface();
    const surface = new CollabPresenceSurface(delegate, {
      staleAfterMs: 2_500,
      sweepIntervalMs: 250,
    });
    delegate.emit(new Map([['desktop-member', {
      user: { name: 'Desktop Member', color: '#E05555' },
    }]]));

    await vi.advanceTimersByTimeAsync(30_000);

    expect(surface.getPresence().participants).toMatchObject([{
      memberId: 'desktop-member',
      displayName: 'Desktop Member',
    }]);
    surface.destroy();
  });
});
