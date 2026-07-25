import { describe, expect, it, vi } from 'vitest';
import { isLexicalSearchEditor } from '../isLexicalSearchEditor';

describe('isLexicalSearchEditor', () => {
  it('accepts the Lexical capabilities used by search and replace', () => {
    expect(
      isLexicalSearchEditor({
        getEditorState: vi.fn(),
        getElementByKey: vi.fn(),
        getRootElement: vi.fn(),
        registerUpdateListener: vi.fn(),
        update: vi.fn(),
      })
    ).toBe(true);
  });

  it('rejects a Monaco editor wrapper', () => {
    expect(
      isLexicalSearchEditor({
        editor: { getAction: vi.fn() },
        getContent: vi.fn(),
        setContent: vi.fn(),
      })
    ).toBe(false);
  });
});
