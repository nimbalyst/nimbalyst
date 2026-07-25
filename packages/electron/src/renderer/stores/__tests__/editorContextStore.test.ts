import { describe, it, expect, beforeEach } from 'vitest';
import {
  setEditorContextItems,
  setEditorContext,
  clearEditorContext,
  dismissEditorContextItem,
  restoreEditorContextItem,
  getEditorContextEntry,
  getActiveEditorContextItems,
  LEGACY_SINGLE_ITEM_ID,
} from '../editorContextStore';

const FILE = '/test/diagram.excalidraw';

describe('editorContextStore', () => {
  beforeEach(() => {
    // Reset store between tests
    clearEditorContext(FILE);
    clearEditorContext('/other/file.ts');
  });

  it('stores pushed items scoped to a file', () => {
    setEditorContextItems(FILE, [
      { id: 'a', label: 'A', description: 'desc a' },
      { id: 'b', label: 'B', description: 'desc b' },
    ]);

    const entry = getEditorContextEntry();
    expect(entry?.filePath).toBe(FILE);
    expect(entry?.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(entry?.dismissedIds.size).toBe(0);
  });

  it('dismisses and restores a single item without dropping it from the list', () => {
    setEditorContextItems(FILE, [
      { id: 'a', label: 'A', description: 'desc a' },
      { id: 'b', label: 'B', description: 'desc b' },
    ]);

    dismissEditorContextItem('a');
    let entry = getEditorContextEntry();
    expect(entry?.dismissedIds.has('a')).toBe(true);
    expect(entry?.items.length).toBe(2); // still present, just dismissed

    restoreEditorContextItem('a');
    entry = getEditorContextEntry();
    expect(entry?.dismissedIds.has('a')).toBe(false);
  });

  it('preserves dismissals when payload refreshes for the same selected ids', () => {
    setEditorContextItems(FILE, [{ id: 'a', label: 'A', description: 'desc a' }]);
    dismissEditorContextItem('a');
    expect(getEditorContextEntry()?.dismissedIds.has('a')).toBe(true);

    // Geometry/text can change while the same item remains selected.
    setEditorContextItems(FILE, [{ id: 'a', label: 'A', description: 'desc a again' }]);
    const entry = getEditorContextEntry();
    expect(entry?.dismissedIds.has('a')).toBe(true);
    expect(entry?.items[0].description).toBe('desc a again');
    expect(entry?.generation).toBeGreaterThan(0);
  });

  it('resets dismissals when the selected id set changes', () => {
    setEditorContextItems(FILE, [{ id: 'a', label: 'A', description: 'desc a' }]);
    dismissEditorContextItem('a');

    setEditorContextItems(FILE, [{ id: 'b', label: 'B', description: 'desc b' }]);
    expect(getEditorContextEntry()?.dismissedIds.size).toBe(0);
  });

  it('bumps generation on each push', () => {
    setEditorContextItems(FILE, [{ id: 'a', label: 'A', description: 'd' }]);
    const g1 = getEditorContextEntry()!.generation;
    setEditorContextItems(FILE, [{ id: 'a', label: 'A', description: 'd' }]);
    const g2 = getEditorContextEntry()!.generation;
    expect(g2).toBeGreaterThan(g1);
  });

  it('clears when passed null/empty for the same file', () => {
    setEditorContextItems(FILE, [{ id: 'a', label: 'A', description: 'd' }]);
    setEditorContextItems(FILE, null);
    expect(getEditorContextEntry()).toBeNull();

    setEditorContextItems(FILE, [{ id: 'a', label: 'A', description: 'd' }]);
    setEditorContextItems(FILE, []);
    expect(getEditorContextEntry()).toBeNull();
  });

  it('does not clear another file\'s context', () => {
    setEditorContextItems(FILE, [{ id: 'a', label: 'A', description: 'd' }]);
    // A different file clearing to null should be a no-op
    setEditorContextItems('/other/file.ts', null);
    expect(getEditorContextEntry()?.filePath).toBe(FILE);
  });

  it('retains context independently for mounted files', () => {
    const otherFile = '/other/file.ts';
    setEditorContextItems(FILE, [{ id: 'a', label: 'A', description: 'd' }]);
    setEditorContextItems(otherFile, [{ id: 'b', label: 'B', description: 'd' }]);

    expect(getEditorContextEntry(FILE)?.items[0].id).toBe('a');
    expect(getEditorContextEntry(otherFile)?.items[0].id).toBe('b');

    dismissEditorContextItem('a', FILE);
    expect(getActiveEditorContextItems(FILE)).toBeUndefined();
    expect(getActiveEditorContextItems(otherFile)?.[0].id).toBe('b');
  });

  it('maps the legacy setEditorContext to a single item', () => {
    setEditorContext(FILE, { label: 'Screen: Login', description: 'the login screen' });
    const entry = getEditorContextEntry();
    expect(entry?.items).toHaveLength(1);
    expect(entry?.items[0].id).toBe(LEGACY_SINGLE_ITEM_ID);
    expect(entry?.items[0].label).toBe('Screen: Login');

    setEditorContext(FILE, null);
    expect(getEditorContextEntry()).toBeNull();
  });
});
