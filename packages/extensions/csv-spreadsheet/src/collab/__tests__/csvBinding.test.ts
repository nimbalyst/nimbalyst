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
