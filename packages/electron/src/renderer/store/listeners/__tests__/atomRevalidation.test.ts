import { atom, createStore } from 'jotai';
import { describe, expect, it } from 'vitest';

import {
  isStructurallyEqual,
  reconcileList,
  setIfChanged,
  setListIfChanged,
} from '../atomRevalidation';

describe('atom revalidation helpers', () => {
  it('treats an absent key and an undefined value as the same', () => {
    expect(isStructurallyEqual({ id: 'a' }, { id: 'a', title: undefined }))
      .toBe(true);
    expect(isStructurallyEqual({ id: 'a' }, { id: 'a', title: 'General' }))
      .toBe(false);
    expect(isStructurallyEqual([{ id: 'a' }], [{ id: 'a' }])).toBe(true);
    expect(isStructurallyEqual([{ id: 'a' }], [{ id: 'b' }])).toBe(false);
    expect(isStructurallyEqual({ nested: { on: true } }, { nested: { on: true } }))
      .toBe(true);
  });

  it('returns the current list when a refresh changed nothing', () => {
    const current = [{ id: 'a' }, { id: 'b' }];
    expect(reconcileList(current, [{ id: 'a' }, { id: 'b' }])).toBe(current);
  });

  it('keeps the identity of a row that only moved', () => {
    const current = [{ id: 'a' }, { id: 'b' }];
    const reconciled = reconcileList(current, [{ id: 'b' }, { id: 'a' }]);

    expect(reconciled).not.toBe(current);
    expect(reconciled[0]).toBe(current[1]);
    expect(reconciled[1]).toBe(current[0]);
  });

  it('writes an atom only when its contents differ', () => {
    const store = createStore();
    const settingsAtom = atom({ roomsEnabled: true });
    const listAtom = atom([{ id: 'a' }]);
    let writes = 0;
    store.sub(settingsAtom, () => { writes += 1; });
    store.sub(listAtom, () => { writes += 1; });

    setIfChanged(store, settingsAtom, { roomsEnabled: true });
    setListIfChanged(store, listAtom, [{ id: 'a' }]);
    expect(writes).toBe(0);

    setIfChanged(store, settingsAtom, { roomsEnabled: false });
    setListIfChanged(store, listAtom, [{ id: 'a' }, { id: 'b' }]);
    expect(writes).toBe(2);
  });
});
