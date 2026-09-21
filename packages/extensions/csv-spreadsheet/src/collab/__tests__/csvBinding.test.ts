// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { CsvBinding } from '../csvBinding';
import { getYCsv } from '../seed';

describe('CsvBinding teardown', () => {
  it('finishes a final sync that started before the binding was destroyed', async () => {
    const yDoc = new Y.Doc();
    const yText = getYCsv(yDoc);
    const initial = 'Name,Count\nAlpha,1\n';
    const withInsertedRow = 'Name,Count\nAlpha,1\nBravo,2\n';
    yText.insert(0, initial);

    let finishSerialization: (content: string) => void = () => {};
    const serialization = new Promise<string>((resolve) => {
      finishSerialization = resolve;
    });
    const binding = new CsvBinding(yDoc, initial, {
      getCurrentCsv: () => serialization,
      onRemoteContent: () => {},
    });

    const finalSync = binding.syncNow();
    binding.destroy();
    finishSerialization(withInsertedRow);
    await finalSync;

    expect(yText.toString()).toBe(withInsertedRow);
    yDoc.destroy();
  });

  it('abandons a final sync when its real Y.Doc is destroyed during serialization', async () => {
    const yDoc = new Y.Doc();
    const yText = getYCsv(yDoc);
    const initial = 'Name,Count\nAlpha,1\n';
    const withInsertedRow = 'Name,Count\nAlpha,1\nBravo,2\n';
    yText.insert(0, initial);

    let finishSerialization: (content: string) => void = () => {};
    const serialization = new Promise<string>((resolve) => {
      finishSerialization = resolve;
    });
    const binding = new CsvBinding(yDoc, initial, {
      getCurrentCsv: () => serialization,
      onRemoteContent: () => {},
    });

    const finalSync = binding.syncNow();
    binding.destroy();
    yDoc.destroy();
    finishSerialization(withInsertedRow);

    await expect(finalSync).resolves.toBeUndefined();
    expect(yText.toString()).toBe(initial);
  });

  /**
   * The invariant that would have caught NIM-2933. `syncNow` is what the host
   * registers as its content drain, and the host decides whether to warn the
   * user about a possibly-lost edit from whether it resolves. Reporting success
   * for a flush that never read — let alone pushed — the content is the one
   * failure mode this drain must not have.
   */
  it('reports failure when the current content cannot be read', async () => {
    const yDoc = new Y.Doc();
    const initial = 'Name,Count\nAlpha,1\n';
    getYCsv(yDoc).insert(0, initial);

    const binding = new CsvBinding(yDoc, initial, {
      getCurrentCsv: () => {
        throw new Error('Grid not available');
      },
      onRemoteContent: () => {},
    });

    await expect(binding.syncNow()).rejects.toThrow(/Grid not available/);
    binding.destroy();
    yDoc.destroy();
  });
});
describe('CsvBinding local sync ordering', () => {
  it('cannot let a slower earlier serialization overwrite a newer cell edit', async () => {
    const yDoc = new Y.Doc();
    const yText = getYCsv(yDoc);
    const initial = 'Name,Count\nAlpha,1\n';
    const firstEdit = 'Name,Count\nAlpha,2\n';
    const secondEdit = 'Name,Count\nAlpha,3\n';
    yText.insert(0, initial);

    let current = firstEdit;
    let releaseFirstSerialization: () => void = () => {};
    const firstSerialization = new Promise<void>((resolve) => {
      releaseFirstSerialization = resolve;
    });
    let serializationCount = 0;
    const binding = new CsvBinding(yDoc, initial, {
      getCurrentCsv: async () => {
        serializationCount += 1;
        const snapshot = current;
        if (serializationCount === 1) await firstSerialization;
        return snapshot;
      },
      onRemoteContent: () => {},
    });

    const firstSync = binding.syncNow();
    await Promise.resolve();
    current = secondEdit;
    const secondSync = binding.syncNow();

    // A second serializer here can resolve first and then be overwritten by the
    // stale first snapshot. One in-flight drain must coalesce this request and
    // read the current grid again after the first serializer finishes.
    expect(serializationCount).toBe(1);
    releaseFirstSerialization();
    await Promise.all([firstSync, secondSync]);

    expect(serializationCount).toBe(2);
    expect(yText.toString()).toBe(secondEdit);
    binding.destroy();
    yDoc.destroy();
  });
});


describe('CsvBinding hydration and remote ordering', () => {
  it('does not publish a partial grid while hydration is pending, but permits intentional deletion afterward', async () => {
    const doc = new Y.Doc();
    const text = getYCsv(doc);
    const initial = 'Name,Count\n' + Array.from({ length: 38 }, (_, i) => `Row${i},${i}`).join('\n');
    text.insert(0, initial);
    let finishHydration!: () => void;
    const ready = new Promise<void>(resolve => { finishHydration = resolve; });
    let current = 'Name,Count\nRow37,37';
    const options = { getCurrentCsv: () => current, onRemoteContent: () => {}, waitUntilReady: () => ready };
    const binding = new CsvBinding(doc, initial, options);
    const syncing = binding.syncNow();
    await Promise.resolve();
    await Promise.resolve();
    expect(text.toString()).toBe(initial);
    current = initial;
    finishHydration();
    await syncing;
    expect(text.toString()).toBe(initial);
    current = 'Name,Count\nRow37,37';
    await binding.syncNow();
    expect(text.toString()).toBe(current);
    binding.destroy();
    doc.destroy();
  });

  it.each([false, true])('preserves a remote insertion during serialization (local edit: %s)', async (hasLocalEdit) => {
    const doc = new Y.Doc();
    const text = getYCsv(doc);
    const initial = 'Name,Count\nAlpha,1';
    text.insert(0, initial);
    let finish!: (value: string) => void;
    const pending = new Promise<string>(resolve => { finish = resolve; });
    const painted: string[] = [];
    const binding = new CsvBinding(doc, initial, {
      getCurrentCsv: () => pending,
      onRemoteContent: value => painted.push(value),
    });
    const syncing = binding.syncNow();
    text.insert(text.length, '\nBravo,2');
    finish(hasLocalEdit ? 'Name,Count\nAlpha,3' : initial);
    await syncing;
    const expected = `Name,Count\nAlpha,${hasLocalEdit ? 3 : 1}\nBravo,2`;
    expect(text.toString()).toBe(expected);
    expect(painted.at(-1)).toBe(expected);
    binding.destroy();
    doc.destroy();
  });
});

it('retains the original read baseline after failure and merges a retry without losing either edit', async () => {
  const doc = new Y.Doc();
  const text = getYCsv(doc);
  text.insert(0, 'A,1\nB,2');
  let reject!: (error: Error) => void;
  let read = () => new Promise<string>((_, fail) => { reject = fail; });
  const painted: string[] = [];
  const binding = new CsvBinding(doc, text.toString(), {
    getCurrentCsv: () => read(), onRemoteContent: value => painted.push(value),
  });
  const first = binding.syncNow();
  text.insert(text.length, '\nC,3');
  reject(new Error('grid read failed'));
  await expect(first).rejects.toThrow('grid read failed');
  expect(painted).toEqual([]);
  read = async () => 'A,9\nB,2';
  await binding.syncNow();
  expect(text.toString()).toBe('A,9\nB,2\nC,3');
  expect(painted).toEqual([text.toString()]);
  binding.destroy(); doc.destroy();
});

it('holds repaint and publication until a whole local operation completes', async () => {
  const doc = new Y.Doc();
  const text = getYCsv(doc);
  const initial = 'A,1\nB,2';
  text.insert(0, initial);
  let current = initial;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const painted: string[] = [];
  const binding = new CsvBinding(doc, initial, {
    getCurrentCsv: () => current, onRemoteContent: value => painted.push(value),
  });
  const mutation = binding.mutate(async () => {
    current = 'A,9';
    await pending;
    current = 'A,9\nB,8';
  });
  const flush = binding.syncNow();
  text.insert(text.length, '\nC,3');
  await Promise.resolve();
  expect(text.toString()).toBe(initial + '\nC,3');
  expect(painted).toEqual([]);
  finish();
  await Promise.all([mutation, flush]);
  expect(text.toString()).toBe('A,9\nB,8\nC,3');
  expect(painted).toEqual([text.toString()]);
  binding.destroy(); doc.destroy();
});

it('keeps a remote row in place between two disjoint local cell changes', async () => {
  const doc = new Y.Doc();
  const text = getYCsv(doc);
  const initial = 'A,1\nB,2\nC,3';
  text.insert(0, initial);
  let finish!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const binding = new CsvBinding(doc, initial, { getCurrentCsv: () => pending, onRemoteContent: () => {} });
  const syncing = binding.syncNow();
  text.insert(initial.indexOf('B,2'), 'Remote,7\n');
  finish('A,9\nB,2\nC,8');
  await syncing;
  expect(text.toString()).toBe('A,9\nRemote,7\nB,2\nC,8');
  binding.destroy(); doc.destroy();
});

it('permits an intentional clear after hydration and reuses one CRDT writer across drains', async () => {
  const doc = new Y.Doc();
  const text = getYCsv(doc);
  text.insert(0, 'A,1');
  let current = 'A,2';
  const binding = new CsvBinding(doc, text.toString(), {
    isReady: () => true, getCurrentCsv: () => current, onRemoteContent: () => {},
  });
  await binding.syncNow();
  const writers = Y.decodeStateVector(Y.encodeStateVector(doc)).size;
  current = 'A,3';
  await binding.syncNow();
  expect(Y.decodeStateVector(Y.encodeStateVector(doc)).size).toBe(writers);
  current = '';
  await binding.syncNow();
  expect(text.toString()).toBe('');
  binding.destroy(); doc.destroy();
});
