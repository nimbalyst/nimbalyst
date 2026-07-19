import { afterEach, describe, expect, it } from 'vitest';
import { editorDirtyAtom, makeEditorKey, store } from '@nimbalyst/runtime/store';
import { collabConnectionStatusAtom } from '../../store/atoms/collabEditor';
import {
  hasDirtyTabs,
  hasUnsyncedCollaborativeTabs,
  shouldPersistTabsSlot,
  type TabData,
} from '../TabsContext';

function tab(filePath: string, isDirty: boolean): TabData {
  return {
    id: filePath,
    filePath,
    fileName: filePath.split('/').at(-1) ?? filePath,
    content: '',
    isDirty,
    isPinned: false,
  };
}

const testedPaths = ['/workspace/restored.md', '/workspace/live.md'];
const collabPath = 'collab://org:test:doc:pending';

afterEach(() => {
  for (const filePath of testedPaths) {
    store.set(editorDirtyAtom(makeEditorKey(filePath)), false);
  }
  store.set(collabConnectionStatusAtom(collabPath), 'disconnected');
});

describe('hasUnsyncedCollaborativeTabs', () => {
  it.each(['offline-unsynced', 'replaying'] as const)(
    'blocks a collaborative tab while its status is %s',
    (status) => {
      const collaborativeTab = tab(collabPath, false);
      store.set(collabConnectionStatusAtom(collabPath), status);

      expect(hasUnsyncedCollaborativeTabs([collaborativeTab])).toBe(true);
    },
  );

  it('allows a collaborative tab after its pending updates are connected', () => {
    const collaborativeTab = tab(collabPath, false);
    store.set(collabConnectionStatusAtom(collabPath), 'connected');

    expect(hasUnsyncedCollaborativeTabs([collaborativeTab])).toBe(false);
  });
});

describe('hasDirtyTabs', () => {
  it('ignores a stale restored TabData dirty flag after the editor is saved', () => {
    const restoredTab = tab('/workspace/restored.md', true);
    store.set(editorDirtyAtom(makeEditorKey(restoredTab.filePath)), false);

    expect(hasDirtyTabs([restoredTab])).toBe(false);
  });

  it('uses the live editor dirty atom as the source of truth', () => {
    const liveTab = tab('/workspace/live.md', false);
    store.set(editorDirtyAtom(makeEditorKey(liveTab.filePath)), true);

    expect(hasDirtyTabs([liveTab])).toBe(true);
  });
});

describe('shouldPersistTabsSlot', () => {
  it('preserves existing persisted tabs while an empty slot is still hydrating', () => {
    expect(shouldPersistTabsSlot(false, 0)).toBe(false);
  });

  it('allows persistence after hydration or once a live tab exists', () => {
    expect(shouldPersistTabsSlot(true, 0)).toBe(true);
    expect(shouldPersistTabsSlot(false, 1)).toBe(true);
  });
});
