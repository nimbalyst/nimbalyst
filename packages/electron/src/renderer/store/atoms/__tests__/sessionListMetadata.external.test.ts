// @vitest-environment node
import { expect, it } from 'vitest';
import { sessionListMetadata } from '../sessionListMetadata';

it('retains external source and activity without changing provider or workspace ownership', () => {
  expect(sessionListMetadata({ id: 'external', createdAt: 1, updatedAt: 2, provider: 'openai-codex', externalSource: 'openai-codex', externalLastActivityAt: 3 }, '/parent')).toMatchObject({
    id: 'external', provider: 'openai-codex', workspaceId: '/parent', externalSource: 'openai-codex', externalLastActivityAt: 3,
  });
  expect(sessionListMetadata({ id: 'local', createdAt: 1, updatedAt: 2 }, '/parent').externalSource).toBeUndefined();
});

vi.mock('../../index', async () => {
  const { createStore } = await import('jotai'); return { store: createStore() };
});
vi.mock('../sessions', async () => {
  const { atom } = await import('jotai');
  return { sessionRegistryAtom: atom(new Map()), sessionListWorkspaceAtom: atom('/parent'), refreshSessionListAtom: atom(null, () => {}), sessionChildrenAtom: () => atom([]), sessionParentIdAtom: () => atom(null) };
});
vi.mock('../workstreamState', async () => {
  const { atom } = await import('jotai'); return { workstreamStateAtom: () => atom({}) };
});
import { vi } from 'vitest';
import { store } from '../../index';
import { sessionRegistryAtom } from '../sessions';
import { initSessionListListeners } from '../../listeners/sessionListListeners';
it('routes targeted external metadata updates into the registry without changing sibling entries', () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  vi.stubGlobal('window', { electronAPI: { on: (channel: string, handler: any) => { handlers.set(channel, handler); return () => {}; } } });
  const own = sessionListMetadata({ id: 'own', createdAt: 1, updatedAt: 2 }, '/parent');
  const sibling = sessionListMetadata({ id: 'sibling', createdAt: 1, updatedAt: 2 }, '/parent');
  store.set(sessionRegistryAtom, new Map([['own', own], ['sibling', sibling]]));
  const dispose = initSessionListListeners();
  try {
    handlers.get('sessions:session-updated')!('own', { externalSource: 'claude-code', externalLastActivityAt: 42 });
    expect(store.get(sessionRegistryAtom).get('own')).toMatchObject({ externalSource: 'claude-code', externalLastActivityAt: 42 });
    expect(store.get(sessionRegistryAtom).get('sibling')).toBe(sibling);
  } finally { dispose(); vi.unstubAllGlobals(); }
});
