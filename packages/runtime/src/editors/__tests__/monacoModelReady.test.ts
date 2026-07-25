import { describe, expect, it, vi } from 'vitest';
import type { editor as MonacoEditorNamespace } from 'monaco-editor';
import { waitForMonacoModel, type MonacoModelWaitTarget } from '../monacoModelReady';

type Model = MonacoEditorNamespace.ITextModel;

/**
 * Minimal fake standing in for the slice of Monaco's IStandaloneCodeEditor
 * that `waitForMonacoModel` touches. Lets us drive the model-attach and
 * dispose lifecycle deterministically without a real Monaco instance.
 */
function createFakeEditor(initialModel: Model | null) {
  let model = initialModel;
  const changeListeners = new Set<() => void>();
  const disposeListeners = new Set<() => void>();
  const editor: MonacoModelWaitTarget = {
    getModel: () => model,
    onDidChangeModel: (listener: () => void) => {
      changeListeners.add(listener);
      return {
        dispose: () => {
          changeListeners.delete(listener);
        },
      };
    },
    onDidDispose: (listener: () => void) => {
      disposeListeners.add(listener);
      return {
        dispose: () => {
          disposeListeners.delete(listener);
        },
      };
    },
  };
  return {
    editor,
    setModel(next: Model | null) {
      model = next;
      changeListeners.forEach((l) => l());
    },
    dispose() {
      disposeListeners.forEach((l) => l());
    },
    hasChangeListeners: () => changeListeners.size > 0,
    hasDisposeListeners: () => disposeListeners.size > 0,
  };
}

/** A stand-in text model; only identity matters for these tests. */
const fakeModel = () => ({}) as Model;

describe('waitForMonacoModel', () => {
  it('resolves immediately with the model when one is already attached', async () => {
    const existing = fakeModel();
    const fake = createFakeEditor(existing);
    await expect(waitForMonacoModel(fake.editor, { timeoutMs: 50 })).resolves.toBe(
      existing
    );
  });

  it('resolves with the model once it is attached after a remount gap', async () => {
    const fake = createFakeEditor(null);
    const promise = waitForMonacoModel(fake.editor, { timeoutMs: 1000 });
    const attached = fakeModel();
    fake.setModel(attached);
    await expect(promise).resolves.toBe(attached);
    // Listeners are torn down after settling.
    expect(fake.hasChangeListeners()).toBe(false);
    expect(fake.hasDisposeListeners()).toBe(false);
  });

  it('resolves null (never throws) when the editor disposes before a model attaches', async () => {
    const fake = createFakeEditor(null);
    const promise = waitForMonacoModel(fake.editor, { timeoutMs: 1000 });
    fake.dispose();
    await expect(promise).resolves.toBeNull();
    expect(fake.hasChangeListeners()).toBe(false);
  });

  it('resolves null on timeout when no model ever attaches', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeEditor(null);
      const promise = waitForMonacoModel(fake.editor, { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
