// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { sessionRegistryAtom } from '../../atoms/sessions';
import { errorNotificationService } from '../../../services/ErrorNotificationService';
import { archiveSessionActionAtom } from '../sessionHistoryActions';

vi.mock('../../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showError: vi.fn() },
}));

describe('archiveSessionActionAtom', () => {
  it('marks the whole subtree archived in the registry after the backend cascade succeeds', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    const store = createStore();
    store.set(activeWorkspacePathAtom, '/ws');
    const row = (id: string, parentSessionId?: string) => [id, { id, parentSessionId, isArchived: false }] as const;
    store.set(sessionRegistryAtom, new Map([row('root'), row('child', 'root'), row('grandchild', 'child'), row('other')]) as any);

    const archived = await store.set(archiveSessionActionAtom, 'root');

    const registry = store.get(sessionRegistryAtom);
    expect(invoke).toHaveBeenCalledWith('sessions:update-metadata', 'root', { isArchived: true });
    expect(archived).toHaveLength(3);
    expect(archived).toEqual(expect.arrayContaining(['root', 'child', 'grandchild']));
    expect(['root', 'child', 'grandchild'].map(id => registry.get(id)?.isArchived)).toEqual([true, true, true]);
    expect(registry.get('other')?.isArchived).toBe(false);
  });

  it('shows an error and changes nothing when the backend rejects the archive', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: false, error: 'Session not found' });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    const store = createStore();
    store.set(activeWorkspacePathAtom, '/ws');
    const row = (id: string, parentSessionId?: string) => [id, { id, parentSessionId, isArchived: false }] as const;
    store.set(sessionRegistryAtom, new Map([row('root'), row('child', 'root')]) as any);

    const archived = await store.set(archiveSessionActionAtom, 'root');

    expect(archived).toEqual([]);
    expect(['root', 'child'].map(id => store.get(sessionRegistryAtom).get(id)?.isArchived)).toEqual([false, false]);
    expect(errorNotificationService.showError).toHaveBeenCalledWith('Failed to archive session', 'Session not found');
  });
});
