// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { sessionRegistryAtom } from '../../atoms/sessions';
import { archiveSessionActionAtom } from '../sessionHistoryActions';

describe('archiveSessionActionAtom', () => {
  it('marks the whole subtree archived in the registry after the backend cascade succeeds', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    const store = createStore();
    store.set(activeWorkspacePathAtom, '/ws');
    const row = (id: string, parentSessionId?: string) => [id, { id, parentSessionId, isArchived: false }] as const;
    store.set(sessionRegistryAtom, new Map([row('root'), row('child', 'root'), row('grandchild', 'child'), row('other')]) as any);

    await store.set(archiveSessionActionAtom, 'root');

    const registry = store.get(sessionRegistryAtom);
    expect(invoke).toHaveBeenCalledWith('sessions:update-metadata', 'root', { isArchived: true });
    expect(['root', 'child', 'grandchild'].map(id => registry.get(id)?.isArchived)).toEqual([true, true, true]);
    expect(registry.get('other')?.isArchived).toBe(false);
  });
});
