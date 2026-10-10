// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { CsvMetaBinding, getYMeta, isMetaEmpty, type CsvMetaSnapshot } from '../metaBinding';
import type { ColumnFormat } from '../../types';
import { EMPTY_FORMATTING } from '../../sheetMeta/formatting';

const EMPTY: CsvMetaSnapshot = {
  ...EMPTY_FORMATTING,
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

  /** A doc shared by a build that predates the Phase 3 fields: no `cellFormats` key at all. */
  function olderSharedPair(): { docA: Y.Doc; docB: Y.Doc } {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.transact(() => {
      const meta = getYMeta(docA);
      meta.set('headerRowCount', 1);
      meta.set('frozenColumnCount', 0);
      meta.set('columnFormats', new Y.Map());
      meta.set('columnWidths', new Y.Map());
      meta.set('cellStyles', new Y.Map());
    });
    sync(docA, docB);
    return { docA, docB };
  }

  it('R3-1: keeps both offline cell formats when the shared doc had no cellFormats yet', () => {
    const { docA, docB } = olderSharedPair();
    const bindingA = new CsvMetaBinding(docA, { onRemoteMeta: () => {} });
    const bindingB = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });

    bindingA.publish(snapshot({ headerRowCount: 1, cellFormats: { A1: DATE_FORMAT }, validation: { A1: { kind: 'checkbox', mode: 'reject' } } }));
    bindingB.publish(snapshot({ headerRowCount: 1, cellFormats: { B1: CURRENCY_FORMAT }, validation: { B1: { kind: 'checkbox', mode: 'warn' } } }));
    sync(docA, docB);

    for (const binding of [bindingA, bindingB]) {
      const merged = binding.snapshot();
      expect(merged.cellFormats).toEqual({ A1: DATE_FORMAT, B1: CURRENCY_FORMAT });
      expect(Object.keys(merged.validation).sort()).toEqual(['A1', 'B1']);
    }
    expect(bindingA.snapshot()).toEqual(bindingB.snapshot());
    docA.destroy();
    docB.destroy();
  });

  /** A doc written by the nested-map build: `cellFormats` is a nested map holding A1 and B1. */
  function nestedLegacyPair(): { docA: Y.Doc; docB: Y.Doc } {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.transact(() => {
      const nested = new Y.Map<unknown>();
      nested.set('A1', DATE_FORMAT);
      nested.set('B1', DATE_FORMAT);
      getYMeta(docA).set('cellFormats', nested);
    });
    sync(docA, docB);
    return { docA, docB };
  }

  const NUMBER_FORMAT: ColumnFormat = { type: 'number', decimals: 2 };

  it('R4-1a: two new clients editing different legacy entries keep both edits', () => {
    const { docA, docB } = nestedLegacyPair();
    const bindingA = new CsvMetaBinding(docA, { onRemoteMeta: () => {} });
    const bindingB = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });

    // Reformatting moves the entry last, the way the record rewrite does.
    bindingA.publish(snapshot({ cellFormats: { B1: DATE_FORMAT, A1: CURRENCY_FORMAT } }));
    bindingB.publish(snapshot({ cellFormats: { A1: DATE_FORMAT, B1: NUMBER_FORMAT } }));
    sync(docA, docB);

    for (const binding of [bindingA, bindingB]) {
      expect(binding.snapshot().cellFormats).toEqual({ A1: CURRENCY_FORMAT, B1: NUMBER_FORMAT });
    }
    expect(bindingA.snapshot()).toEqual(bindingB.snapshot());
    docA.destroy();
    docB.destroy();
  });

  // An edit in place keeps record order, so the untouched neighbour after it must
  // get at most a new order stamp, never a republished copy of its old value.
  it.each([[2, 1], [1, 2]])('R4-1c: in-place edits of neighbouring legacy entries both survive (client ids A=%i, B=%i)', (idA, idB) => {
    const seed = new Y.Doc();
    seed.transact(() => {
      const nested = new Y.Map<unknown>();
      nested.set('A1', DATE_FORMAT);
      nested.set('B1', DATE_FORMAT);
      getYMeta(seed).set('cellFormats', nested);
    });
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.clientID = idA;
    docB.clientID = idB;
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(seed));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(seed));
    const bindingA = new CsvMetaBinding(docA, { onRemoteMeta: () => {} });
    const bindingB = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });

    bindingA.publish(snapshot({ cellFormats: { A1: CURRENCY_FORMAT, B1: DATE_FORMAT } }));
    bindingB.publish(snapshot({ cellFormats: { A1: DATE_FORMAT, B1: NUMBER_FORMAT } }));
    sync(docA, docB);

    for (const binding of [bindingA, bindingB]) {
      expect(binding.snapshot().cellFormats).toEqual({ A1: CURRENCY_FORMAT, B1: NUMBER_FORMAT });
    }
    expect(Object.keys(bindingA.snapshot().cellFormats)).toEqual(Object.keys(bindingB.snapshot().cellFormats));
    for (const doc of [seed, docA, docB]) doc.destroy();
  });

  it('R4-1b: an older client adding a nested entry during migration keeps it', () => {
    const { docA: docNew, docB: docOld } = nestedLegacyPair();
    const binding = new CsvMetaBinding(docNew, { onRemoteMeta: () => {} });

    // Concurrently: the new client reformats A1, the older build adds C1 to the nested map.
    binding.publish(snapshot({ cellFormats: { B1: DATE_FORMAT, A1: CURRENCY_FORMAT } }));
    (getYMeta(docOld).get('cellFormats') as Y.Map<unknown>).set('C1', NUMBER_FORMAT);
    sync(docNew, docOld);

    expect(binding.snapshot().cellFormats).toEqual({ B1: DATE_FORMAT, C1: NUMBER_FORMAT, A1: CURRENCY_FORMAT });
    const nested = getYMeta(docOld).get('cellFormats') as Y.Map<unknown>;
    expect(nested.toJSON()).toEqual({ A1: DATE_FORMAT, B1: DATE_FORMAT, C1: NUMBER_FORMAT });
    docNew.destroy();
    docOld.destroy();
  });

  it('R4-1: old and new clients interoperate through the untouched nested map', () => {
    const { docA: docNew, docB: docOld } = nestedLegacyPair();
    const binding = new CsvMetaBinding(docNew, { onRemoteMeta: () => {} });
    const nestedOld = () => getYMeta(docOld).get('cellFormats') as Y.Map<unknown>;

    // Old client edits an entry: the new client sees it.
    nestedOld().set('B1', CURRENCY_FORMAT);
    sync(docNew, docOld);
    expect(binding.snapshot().cellFormats).toEqual({ A1: DATE_FORMAT, B1: CURRENCY_FORMAT });

    // New client edits A1 and clears B1: the flat entries shadow the nested ones
    // for new clients, while the older build keeps reading its nested map as-is
    // (its view of A1 and B1 lags; that is the documented limit).
    binding.publish(snapshot({ cellFormats: { A1: NUMBER_FORMAT } }));
    sync(docNew, docOld);
    expect(new CsvMetaBinding(docOld, { onRemoteMeta: () => {} }).snapshot().cellFormats).toEqual({ A1: NUMBER_FORMAT });
    expect(nestedOld().toJSON()).toEqual({ A1: DATE_FORMAT, B1: CURRENCY_FORMAT });

    // Re-adding the cleared entry brings it back for new clients.
    binding.publish(snapshot({ cellFormats: { A1: NUMBER_FORMAT, B1: DATE_FORMAT } }));
    expect(binding.snapshot().cellFormats).toEqual({ A1: NUMBER_FORMAT, B1: DATE_FORMAT });
    docNew.destroy();
    docOld.destroy();
  });

  it('R3-1: reads the nested Phase 3 shape without losing entries', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.transact(() => {
      const meta = getYMeta(docA);
      meta.set('headerRowCount', 1);
      const nested = new Y.Map<unknown>();
      nested.set('A1:A3', DATE_FORMAT);
      nested.set('A2', CURRENCY_FORMAT);
      meta.set('cellFormats', nested);
      const conditional = new Y.Map<unknown>();
      conditional.set('cf-b', { order: 1, format: { id: 'cf-b', ranges: ['B1'], rule: { kind: 'notEmpty' }, style: {} } });
      conditional.set('cf-a', { order: 0, format: { id: 'cf-a', ranges: ['A1'], rule: { kind: 'notEmpty' }, style: {} } });
      meta.set('conditionalFormats', conditional);
    });
    sync(docA, docB);

    const bindingA = new CsvMetaBinding(docA, { onRemoteMeta: () => {} });
    const legacy = bindingA.snapshot();
    expect(Object.keys(legacy.cellFormats)).toEqual(['A1:A3', 'A2']);
    expect(legacy.conditionalFormats.map((format) => format.id)).toEqual(['cf-a', 'cf-b']);

    // A local write adds only its own entry; the nested map stays for older builds.
    bindingA.publish({ ...legacy, cellFormats: { ...legacy.cellFormats, B5: DATE_FORMAT } });
    expect([...getYMeta(docA).keys()].filter((key) => key.startsWith('cellFormats/'))).toEqual(['cellFormats/B5']);
    expect(getYMeta(docA).get('cellFormats')).toBeInstanceOf(Y.Map);
    sync(docA, docB);
    const bindingB = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });
    expect(Object.keys(bindingB.snapshot().cellFormats)).toEqual(['A1:A3', 'A2', 'B5']);
    expect(bindingB.snapshot().conditionalFormats.map((format) => format.id)).toEqual(['cf-a', 'cf-b']);
    docA.destroy();
    docB.destroy();
  });

  it('R3-2: a re-applied overlapping range takes precedence on every client', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const bindingA = new CsvMetaBinding(docA, { onRemoteMeta: () => {} });
    const bindingB = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });
    const NUMBER_FORMAT: ColumnFormat = { type: 'number', decimals: 2 };

    bindingA.publish(snapshot({ cellFormats: { 'A1:A3': NUMBER_FORMAT, 'A2:A4': DATE_FORMAT } }));
    sync(docA, docB);
    // Reformatting A1:A3 replaces its entry and moves it last, so A2 shows currency locally.
    const local = snapshot({ cellFormats: { 'A2:A4': DATE_FORMAT, 'A1:A3': CURRENCY_FORMAT } });
    bindingA.publish(local);
    sync(docA, docB);

    expect(Object.keys(bindingB.snapshot().cellFormats)).toEqual(['A2:A4', 'A1:A3']);
    expect(bindingA.snapshot()).toEqual(local);
    expect(bindingB.snapshot()).toEqual(local);
    docA.destroy();
    docB.destroy();
  });

  it('R3-2: concurrent overlapping borders resolve to the same order on both clients', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const bindingA = new CsvMetaBinding(docA, { onRemoteMeta: () => {} });
    const bindingB = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });
    bindingA.publish(snapshot({ borders: { 'A1:B2': { top: { style: 'thin' } } } }));
    sync(docA, docB);

    bindingA.publish(snapshot({ borders: { 'A1:B2': { top: { style: 'thin' } }, A1: { top: { style: 'thick' } } } }));
    bindingB.publish(snapshot({ borders: { 'A1:B2': { top: { style: 'thin' } }, 'A1:A2': { top: { style: 'dashed' } } } }));
    sync(docA, docB);

    const merged = bindingA.snapshot();
    expect(bindingB.snapshot()).toEqual(merged);
    expect(Object.keys(merged.borders)[0]).toBe('A1:B2');
    expect(Object.keys(merged.borders).sort()).toEqual(['A1', 'A1:A2', 'A1:B2']);
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
