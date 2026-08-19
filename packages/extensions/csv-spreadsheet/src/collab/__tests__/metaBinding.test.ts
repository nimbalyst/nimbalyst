// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { CsvMetaBinding, getYMeta, isMetaEmpty, type CsvMetaSnapshot } from '../metaBinding';
import type { ColumnFormat } from '../../types';

const EMPTY: CsvMetaSnapshot = {
  headerRowCount: 0,
  frozenColumnCount: 0,
  columnFormats: {},
  columnWidths: {},
  cellStyles: {},
};

const snapshot = (patch: Partial<CsvMetaSnapshot>): CsvMetaSnapshot => ({ ...EMPTY, ...patch });

const DATE_FORMAT: ColumnFormat = { type: 'date', dateFormat: 'MM/DD/YYYY' };
const CURRENCY_FORMAT: ColumnFormat = { type: 'currency', currency: 'USD', decimals: 2 };

/** Exchange updates both ways, the way a connected pair of clients would. */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('CsvMetaBinding', () => {
  /**
   * The reason this binding exists. Metadata used to ride along inside the
   * whole-CSV Y.Text as a single comment line, so two people formatting two
   * different columns produced overlapping edits to the same line and one of
   * them lost their format with no warning.
   */
  it('merges concurrent formatting of different columns', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const bindingA = new CsvMetaBinding(docA, { onRemoteMeta: () => {} });
    const bindingB = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });

    // Both start from the same shared state.
    bindingA.publish(snapshot({ headerRowCount: 1 }));
    sync(docA, docB);

    // Offline, at the same time: A formats column 0, B formats column 3.
    bindingA.publish(snapshot({ headerRowCount: 1, columnFormats: { 0: DATE_FORMAT } }));
    bindingB.publish(snapshot({ headerRowCount: 1, columnFormats: { 3: CURRENCY_FORMAT } }));

    sync(docA, docB);

    for (const binding of [bindingA, bindingB]) {
      expect(binding.snapshot().columnFormats).toEqual({ 0: DATE_FORMAT, 3: CURRENCY_FORMAT });
    }

    docA.destroy();
    docB.destroy();
  });

  it('merges concurrent column resizes', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const bindingA = new CsvMetaBinding(docA, { onRemoteMeta: () => {} });
    const bindingB = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });
    bindingA.publish(snapshot({ columnWidths: { 0: 100 } }));
    sync(docA, docB);

    bindingA.publish(snapshot({ columnWidths: { 0: 100, 1: 220 } }));
    bindingB.publish(snapshot({ columnWidths: { 0: 100, 2: 340 } }));
    sync(docA, docB);

    expect(bindingA.snapshot().columnWidths).toEqual({ 0: 100, 1: 220, 2: 340 });
    docA.destroy();
    docB.destroy();
  });

  it('propagates a cleared format as a deletion rather than a stale entry', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const bindingA = new CsvMetaBinding(docA, { onRemoteMeta: () => {} });
    const bindingB = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });

    bindingA.publish(snapshot({ columnFormats: { 0: DATE_FORMAT, 1: CURRENCY_FORMAT } }));
    sync(docA, docB);
    expect(bindingB.snapshot().columnFormats).toEqual({ 0: DATE_FORMAT, 1: CURRENCY_FORMAT });

    bindingA.publish(snapshot({ columnFormats: { 1: CURRENCY_FORMAT } }));
    sync(docA, docB);

    expect(bindingB.snapshot().columnFormats).toEqual({ 1: CURRENCY_FORMAT });
    docA.destroy();
    docB.destroy();
  });

  it('notifies on a remote change but never echoes a local one', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const onRemoteA = vi.fn();
    const bindingA = new CsvMetaBinding(docA, { onRemoteMeta: onRemoteA });
    const bindingB = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });

    // A local write must not come back as a remote change; it would fight the
    // edit the user is still making.
    bindingA.publish(snapshot({ frozenColumnCount: 2 }));
    expect(onRemoteA).not.toHaveBeenCalled();

    sync(docA, docB);
    bindingB.publish(snapshot({ frozenColumnCount: 2, columnFormats: { 4: DATE_FORMAT } }));
    sync(docA, docB);

    expect(onRemoteA).toHaveBeenCalled();
    expect(onRemoteA.mock.calls.at(-1)?.[0].columnFormats).toEqual({ 4: DATE_FORMAT });
    docA.destroy();
    docB.destroy();
  });

  /**
   * Sheets shared before metadata had its own key carry it only in the CSV
   * comment line, so the first client to open one seeds the map. Two clients
   * racing to do that write identical values and must converge.
   */
  it('converges when two clients seed the same legacy metadata at once', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    expect(isMetaEmpty(docA)).toBe(true);

    const legacy = snapshot({ headerRowCount: 1, columnFormats: { 2: DATE_FORMAT } });
    new CsvMetaBinding(docA, { onRemoteMeta: () => {} }).publish(legacy);
    new CsvMetaBinding(docB, { onRemoteMeta: () => {} }).publish(legacy);
    sync(docA, docB);

    expect(isMetaEmpty(docA)).toBe(false);
    expect(getYMeta(docA).get('headerRowCount')).toBe(1);
    const merged = new CsvMetaBinding(docA, { onRemoteMeta: () => {} }).snapshot();
    expect(merged).toEqual(legacy);
    docA.destroy();
    docB.destroy();
  });

  it('stops observing once destroyed', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const onRemoteA = vi.fn();
    const bindingA = new CsvMetaBinding(docA, { onRemoteMeta: onRemoteA });
    const bindingB = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });

    bindingA.destroy();
    bindingB.publish(snapshot({ headerRowCount: 3 }));
    sync(docA, docB);

    expect(onRemoteA).not.toHaveBeenCalled();
    docA.destroy();
    docB.destroy();
  });
});
