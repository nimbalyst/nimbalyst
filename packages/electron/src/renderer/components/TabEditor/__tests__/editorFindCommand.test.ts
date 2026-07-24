import { describe, expect, it, vi } from 'vitest';
import {
  hasEditorFind,
  openEditorFind,
  registerEditorFindHandler,
} from '../editorFindCommand';

describe('editorFindCommand', () => {
  it('routes a find request to the handler registered for the file path', () => {
    const handler = vi.fn();
    const unregister = registerEditorFindHandler('/workspace/package-lock.json', handler);

    expect(openEditorFind('/workspace/package-lock.json')).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(openEditorFind('/workspace/other.json')).toBe(false);

    unregister();
  });

  it('stops routing after the handler unregisters', () => {
    const handler = vi.fn();
    const unregister = registerEditorFindHandler('/workspace/a.md', handler);
    unregister();

    expect(openEditorFind('/workspace/a.md')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not let a stale unregister remove a newer handler for the same file', () => {
    const stale = vi.fn();
    const current = vi.fn();
    const unregisterStale = registerEditorFindHandler('/workspace/b.md', stale);
    const unregisterCurrent = registerEditorFindHandler('/workspace/b.md', current);

    unregisterStale();

    expect(openEditorFind('/workspace/b.md')).toBe(true);
    expect(current).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();

    unregisterCurrent();
  });

  it('detects editors that expose their own find UI', () => {
    expect(hasEditorFind({ openFind: vi.fn() })).toBe(true);
  });

  it('does not treat a Lexical editor as find-capable', () => {
    expect(hasEditorFind({ registerUpdateListener: vi.fn() })).toBe(false);
    expect(hasEditorFind(null)).toBe(false);
    expect(hasEditorFind(undefined)).toBe(false);
  });
});
