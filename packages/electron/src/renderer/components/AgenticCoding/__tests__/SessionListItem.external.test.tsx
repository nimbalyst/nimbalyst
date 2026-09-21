// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../../store', async () => {
  const { atom } = await import('jotai');
  const empty = atom(undefined);
  return Object.fromEntries(['sessionOrChildProcessingAtom', 'sessionUnreadAtom', 'sessionPendingPromptAtom', 'sessionHasPendingInteractivePromptAtom', 'reparentSessionAtom', 'refreshSessionListAtom', 'sessionShareAtom', 'sessionWakeupAtom', 'sessionLastActivityAtom'].map(key => [key, () => empty]));
});
vi.mock('../../../store/atoms/sessions', async () => {
  const { atom } = await import('jotai');
  return { sessionRegistryAtom: atom(new Map()), convertToWorkstreamAtom: atom(null, () => {}) };
});
vi.mock('../../../store/atoms/teamInbox', async () => {
  const { atom } = await import('jotai'); const value = atom(false);
  return { sessionAgentWakePendingAtom: () => value };
});
vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));
vi.mock('../SessionProviderIcon', () => ({ SessionProviderIcon: () => <span>Provider badge</span> }));
vi.mock('../FullTitleTooltip', () => ({ FullTitleTooltip: ({ children }: any) => <span>{children}</span> }));
import { SessionListItem } from '../SessionListItem';
import { sessionRegistryAtom } from '../../../store/atoms/sessions';
import { settingAtom } from '../../../store/atoms/settingAtomFamily';
const base = 1_700_000_000_000;
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('reacts to its own metadata, expires following, and revokes it immediately when disabled', () => {
  vi.useFakeTimers(); vi.setSystemTime(base);
  window.electronAPI = {} as any;
  const store = createStore();
  const following = settingAtom('app.externalSessionFollowEnabled');
  store.set(sessionRegistryAtom, new Map([['s1', { id: 's1', externalSource: 'openai-codex', externalLastActivityAt: base } as any]]));
  const ownRender = vi.fn();
  const siblingRender = vi.fn();
  render(<Provider store={store}>
    <React.Profiler id="own" onRender={ownRender}><SessionListItem id="s1" title="External task" createdAt={base} isActive={false} onClick={() => {}} /></React.Profiler>
    <React.Profiler id="sibling" onRender={siblingRender}><SessionListItem id="s2" title="Local task" createdAt={base} isActive={false} onClick={() => {}} /></React.Profiler>
  </Provider>);
  screen.getByText('External');
  expect(screen.queryByText('Following')).toBeNull();
  act(() => { store.set(following, true); });
  screen.getByText('Following');
  expect(screen.getAllByText('Provider badge')).toHaveLength(2);
  ownRender.mockClear(); siblingRender.mockClear();
  act(() => { vi.advanceTimersByTime(30_001); });
  expect(ownRender).toHaveBeenCalled();
  expect(siblingRender).not.toHaveBeenCalled();
  expect(screen.queryByText('Following')).toBeNull();
  screen.getByText('External');
  act(() => { store.set(sessionRegistryAtom, new Map([['s1', { id: 's1', externalSource: 'openai-codex', externalLastActivityAt: Date.now() } as any]])); });
  screen.getByText('Following');
  act(() => { store.set(following, false); });
  expect(screen.queryByText('Following')).toBeNull();
  screen.getByText('External');
});
