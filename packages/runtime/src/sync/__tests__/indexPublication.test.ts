// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createIndexPublicationGate,
  createKeyedSerialQueue,
  indexPatchSignature,
} from '../indexPublication';

describe('indexPatchSignature', () => {
  it('ignores key order and absent-vs-undefined members', () => {
    const a = indexPatchSignature({
      isExecuting: true,
      clientMetadata: { phase: 'implementing', tags: ['a', 'b'], draftInput: undefined },
    });
    const b = indexPatchSignature({
      clientMetadata: { tags: ['a', 'b'], phase: 'implementing' },
      isExecuting: true,
      lastReadAt: undefined,
    });
    expect(a).toBe(b);
  });

  it('separates an explicit clear from an absent field, and keeps array order', () => {
    expect(indexPatchSignature({ clientMetadata: { draftInput: '' } }))
      .not.toBe(indexPatchSignature({ clientMetadata: {} }));
    expect(indexPatchSignature({ clientMetadata: { tags: ['a', 'b'] } }))
      .not.toBe(indexPatchSignature({ clientMetadata: { tags: ['b', 'a'] } }));
    expect(indexPatchSignature({ lastReadAt: 1 })).not.toBe(indexPatchSignature({ lastReadAt: 2 }));
  });
});

describe('createIndexPublicationGate', () => {
  it('publishes unknown sessions, suppresses repeats, and forgets on invalidate/reset', () => {
    const gate = createIndexPublicationGate();
    expect(gate.shouldPublish('s1', 'sig-a')).toBe(true);

    gate.recordPublished('s1', 'sig-a');
    expect(gate.shouldPublish('s1', 'sig-a')).toBe(false);
    expect(gate.shouldPublish('s1', 'sig-b')).toBe(true);
    expect(gate.shouldPublish('s2', 'sig-a')).toBe(true);

    gate.invalidate('s1');
    expect(gate.shouldPublish('s1', 'sig-a')).toBe(true);

    gate.recordPublished('s1', 'sig-a');
    gate.reset();
    expect(gate.shouldPublish('s1', 'sig-a')).toBe(true);
  });
});

describe('createKeyedSerialQueue', () => {
  it('serializes one key, runs distinct keys concurrently, and survives a rejection', async () => {
    const queue = createKeyedSerialQueue();
    const order: string[] = [];
    const defer = (label: string, ms: number) => () =>
      new Promise<void>((resolve) => setTimeout(() => {
        order.push(label);
        resolve();
      }, ms));

    const sameKey = Promise.all([
      queue.run('a', defer('a1', 20)),
      queue.run('a', defer('a2', 1)),
    ]);
    const otherKey = queue.run('b', defer('b1', 5));
    await Promise.all([sameKey, otherKey]);
    // 'a2' waited for the slower 'a1'; 'b1' did not.
    expect(order.indexOf('a1')).toBeLessThan(order.indexOf('a2'));
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('a1'));

    const failing = queue.run('a', async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(queue.run('a', async () => 'ok')).resolves.toBe('ok');
  });
});
