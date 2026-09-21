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
