import { describe, expect, it } from 'vitest';
import {
  MAX_EDITOR_CONTEXT_DATA_CHARS,
  serializeEditorContextItemsForIpc,
} from '../editorContextSerialization';

describe('serializeEditorContextItemsForIpc', () => {
  it('strips structured data unless the item explicitly opts in', () => {
    const result = serializeEditorContextItemsForIpc([
      { id: 'a', label: 'A', description: 'desc', data: { secret: true } },
    ]);

    expect(result).toEqual([{ id: 'a', label: 'A', description: 'desc' }]);
  });

  it('clones opted-in JSON data into a structured-clone-safe value', () => {
    const source = { nested: { value: '10k' } };
    const result = serializeEditorContextItemsForIpc([
      { id: 'a', label: 'A', description: 'desc', data: source, includeData: true },
    ]);

    expect(result?.[0].data).toEqual(source);
    expect(result?.[0].data).not.toBe(source);
    expect(result?.[0].includeData).toBe(true);
  });

  it('omits cyclic, BigInt, and oversized data instead of failing the message', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const result = serializeEditorContextItemsForIpc([
      { id: 'cyclic', label: 'Cyclic', description: 'desc', data: cyclic, includeData: true },
      { id: 'bigint', label: 'BigInt', description: 'desc', data: 1n, includeData: true },
      {
        id: 'large',
        label: 'Large',
        description: 'desc',
        data: 'x'.repeat(MAX_EDITOR_CONTEXT_DATA_CHARS + 1),
        includeData: true,
      },
    ]);

    expect(result).toEqual([
      { id: 'cyclic', label: 'Cyclic', description: 'desc' },
      { id: 'bigint', label: 'BigInt', description: 'desc' },
      { id: 'large', label: 'Large', description: 'desc' },
    ]);
  });
});
