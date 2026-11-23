// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createSyncedSessionStore } from '../SyncedSessionStore';
import { AISessionsRepository } from '../../storage/repositories/AISessionsRepository';
import type { SessionStore } from '../../ai/adapters/sessionStore';
import type { SyncProvider } from '../types';

afterEach(() => AISessionsRepository.clearStore());

it('preserves batch hydration through the sync decorator for a heavily linked file', async () => {
  const ids = Array.from({ length: 916 }, (_, i) => `session-${i}`);
  const sessions = ids.map(id => ({ id }));
  const get = vi.fn(async (id: string) => sessions.find(session => session.id === id));
  const getMany = vi.fn(async () => sessions);
  const connect = vi.fn();
  AISessionsRepository.setStore(createSyncedSessionStore(
    { get, getMany } as unknown as SessionStore,
    { connect } as unknown as SyncProvider,
  ));

  expect(await AISessionsRepository.getMany(ids)).toEqual(sessions);
  expect(getMany).toHaveBeenCalledExactlyOnceWith(ids);
  expect(get).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});

// GitHub #1901: after an app restart no session is "connected", so deleting an
// older session never told the sync server and the session came back.
it('sends session_deleted for a session that was never connected, then deletes locally', async () => {
  const order: string[] = [];
  const pushChange = vi.fn(async () => { order.push('push'); return { published: true } as const; });
  const disconnect = vi.fn();
  const baseDelete = vi.fn(async () => { order.push('local'); });
  const store = createSyncedSessionStore(
    { delete: baseDelete } as unknown as SessionStore,
    { pushChange, disconnect } as unknown as SyncProvider,
  );

  await store.delete('old-session');

  expect(pushChange).toHaveBeenCalledExactlyOnceWith('old-session', { type: 'session_deleted' });
  expect(baseDelete).toHaveBeenCalledExactlyOnceWith('old-session');
  expect(order).toEqual(['push', 'local']);
});

it('still deletes locally at once when the sync delete is deferred', async () => {
  const pushChange = vi.fn(async () => ({ published: false, reason: 'index delete deferred', retryable: true }) as const);
  const baseDelete = vi.fn(async () => {});
  const store = createSyncedSessionStore(
    { delete: baseDelete } as unknown as SessionStore,
    { pushChange, disconnect: vi.fn() } as unknown as SyncProvider,
  );

  await store.delete('old-session');

  expect(baseDelete).toHaveBeenCalledExactlyOnceWith('old-session');
});
