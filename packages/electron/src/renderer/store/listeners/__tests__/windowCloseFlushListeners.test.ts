// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DocumentModel } from '../../../services/document-model/DocumentModel';
import { DocumentModelRegistry } from '../../../services/document-model/DocumentModelRegistry';
import type { DocumentBackingStore } from '../../../services/document-model/types';
import { initWindowCloseFlushListeners } from '../windowCloseFlushListeners';

// Real DocumentModelRegistry + DocumentModel, with a mock backing store, so
// these tests exercise the actual "flush, then re-check isDirty" path that
// tells main whether it is safe to close the donor window -- not just that
// the listener called some flush function.
function createMockStore(): DocumentBackingStore {
  return {
    load: vi.fn(async () => ''),
    save: vi.fn(async () => {}),
    onExternalChange: vi.fn(() => () => {}),
  };
}

describe('windowCloseFlushListeners', () => {
  let handlers: Map<string, (data: unknown) => void>;
  let send: ReturnType<typeof vi.fn>;
  let cleanup: () => void;

  beforeEach(() => {
    DocumentModelRegistry.clear();
    DocumentModelRegistry.setModelFactory((filePath: string) => new DocumentModel(filePath, createMockStore(), {
      autosaveInterval: 0,
    }));

    handlers = new Map();
    send = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        send,
        on: (channel: string, callback: (data: unknown) => void) => {
          handlers.set(channel, callback);
          return () => handlers.delete(channel);
        },
      },
    });

    cleanup = initWindowCloseFlushListeners();
  });

  afterEach(() => {
    cleanup();
    DocumentModelRegistry.clear();
    DocumentModelRegistry.setModelFactory(null);
    vi.unstubAllGlobals();
  });

  it('acks "flushed" once a dirty model saves successfully', async () => {
    const { model, handle } = DocumentModelRegistry.getOrCreate(
      '/ws/a.md',
      { autosaveInterval: 0 },
    );
    const unregisterSave = handle.onSaveRequested(async () => {
      await handle.saveContent('new content');
    });
    handle.setDirty(true);
    expect(model.isDirty()).toBe(true);

    handlers.get('window:flush-before-close')?.({ requestId: 'req-1' });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith('window:flush-before-close-result', {
        requestId: 'req-1',
        outcome: 'flushed',
      });
    });
    expect(model.isDirty()).toBe(false);
    unregisterSave();
    handle.detach();
  });

  it('acks "still-dirty" when a save-requested callback does not clear the dirty flag', async () => {
    const { model, handle } = DocumentModelRegistry.getOrCreate(
      '/ws/b.md',
      { autosaveInterval: 0 },
    );
    // Registers a save-requested callback that fails (rejects) -- DocumentModel
    // swallows the throw internally, so this stands in for a write that never
    // lands. The dirty flag is never cleared because saveContent is never called.
    const unregisterSave = handle.onSaveRequested(async () => {
      throw new Error('disk write failed');
    });
    handle.setDirty(true);

    handlers.get('window:flush-before-close')?.({ requestId: 'req-2' });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith('window:flush-before-close-result', {
        requestId: 'req-2',
        outcome: 'still-dirty',
      });
    });
    expect(model.isDirty()).toBe(true);
    unregisterSave();
    handle.detach();
  });

  it('acks "flushed" with no dirty models at all', async () => {
    handlers.get('window:flush-before-close')?.({ requestId: 'req-3' });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith('window:flush-before-close-result', {
        requestId: 'req-3',
        outcome: 'flushed',
      });
    });
  });

  it('ignores a request with no requestId', async () => {
    handlers.get('window:flush-before-close')?.({});
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
  });
});
