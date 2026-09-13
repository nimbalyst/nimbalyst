// @vitest-environment jsdom
import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import {
  $getRoot,
  $createParagraphNode,
  $createTextNode,
  type LexicalEditor,
} from 'lexical';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  getImagePluginCallbacks,
  setImagePluginCallbacks,
} from '@nimbalyst/runtime/editor/plugins/ImagesPlugin';
import {
  IMAGE_STAGE_TIMEOUT_MS,
  TrackerQuickCreateEditor,
} from '../TrackerQuickCreateEditor';
import { trackerQuickCreateDraftAtom } from '../../../store/atoms/trackerQuickCreate';

const stage = vi.fn();
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      documentService: { stageTrackerImage: stage },
      settingsGetAll: vi.fn().mockResolvedValue({}),
    },
  });
  stage.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function harness() {
  const store = createStore();
  const draftAtom = trackerQuickCreateDraftAtom('/screenshots');
  const onSubmit = vi.fn();
  const renderEditor = () =>
    render(
      <Provider store={store}>
        <TrackerQuickCreateEditor
          workspacePath="/screenshots"
          draftId={store.get(draftAtom).id}
          draftAtom={draftAtom}
          onSubmit={onSubmit}
        />
      </Provider>,
    );
  const file = new File(['image'], 'screen.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new Uint8Array([137, 80, 78, 71]).buffer,
  });
  return { store, draftAtom, renderEditor, file, onSubmit };
}

it('submits on Cmd/Ctrl+Enter from the body and leaves plain Enter to the editor', async () => {
  const { store, draftAtom, renderEditor, onSubmit } = harness();
  renderEditor();
  const editable = await screen.findByRole('textbox');
  const editor = (editable as any).__lexicalEditor as LexicalEditor;
  await act(async () =>
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createParagraphNode().append($createTextNode('One line')));
      },
      { discrete: true },
    ),
  );
  await waitFor(() => expect(store.get(draftAtom).description).toBe('One line'));
  await act(async () => editor.focus());
  // Lexical's rich-text plugin prevents default on every Enter, so the popup's
  // wrapper handler never sees this one; the editor has to claim it itself.
  fireEvent.keyDown(editable, { key: 'Enter', metaKey: true });
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(store.get(draftAtom).description).toBe('One line');
  fireEvent.keyDown(editable, { key: 'Enter', ctrlKey: true });
  expect(onSubmit).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(editable, { key: 'Enter' });
  expect(onSubmit).toHaveBeenCalledTimes(2);
});

it('hands the image callback slot back to the editor underneath on unmount', async () => {
  const { renderEditor } = harness();
  const underneath = { resolveImageSrc: async () => 'underneath' };
  setImagePluginCallbacks(underneath);
  const mounted = renderEditor();
  await screen.findByRole('textbox');
  expect(getImagePluginCallbacks()).not.toBe(underneath);
  mounted.unmount();
  expect(getImagePluginCallbacks()).toBe(underneath);
});

it('turns a stage request that never answers into a failed image instead of blocking submit forever', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const { store, draftAtom, renderEditor, file } = harness();
    stage.mockImplementation(() => new Promise(() => {}));
    const mounted = renderEditor();
    fireEvent.change(mounted.container.querySelector('input[type=file]')!, {
      target: { files: [file] },
    });
    await waitFor(() => expect(store.get(draftAtom).pendingImages).toBe(1));
    await act(async () => {
      vi.advanceTimersByTime(IMAGE_STAGE_TIMEOUT_MS);
    });
    await waitFor(() => expect(store.get(draftAtom).pendingImages).toBe(0));
    expect(store.get(draftAtom).failedImages[0].error).toContain('timed out');
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});

it('keeps every editor change in the draft and preserves its text across remount', async () => {
  const { store, draftAtom, renderEditor } = harness();
  const mounted = renderEditor();
  const editable = await screen.findByRole('textbox');
  const editor = (editable as any).__lexicalEditor as LexicalEditor;
  for (const text of ['First change', 'Second change Ω']) {
    await act(async () =>
      editor.update(
        () => {
          $getRoot()
            .clear()
            .append($createParagraphNode().append($createTextNode(text)));
        },
        { discrete: true },
      ),
    );
    await waitFor(() =>
      expect(store.get(draftAtom).description).toContain(text),
    );
  }
  mounted.unmount();
  renderEditor();
  expect((await screen.findByRole('textbox')).textContent).toContain(
    'Second change Ω',
  );
});

it('inserts a screenshot into the current editor when staging finishes after a remount', async () => {
  const { store, draftAtom, renderEditor, file } = harness();
  let finish!: (value: { relativePath: string }) => void;
  stage.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const mounted = renderEditor();
  fireEvent.change(mounted.container.querySelector('input[type=file]')!, {
    target: { files: [file] },
  });
  await waitFor(() => expect(stage).toHaveBeenCalledTimes(1));
  expect(store.get(draftAtom).pendingImages).toBe(1);
  mounted.unmount();
  renderEditor();
  await act(async () =>
    finish({ relativePath: '.nimbalyst/assets/screen.png' }),
  );
  await waitFor(() =>
    expect(store.get(draftAtom).description).toContain(
      '.nimbalyst/assets/screen.png',
    ),
  );
  expect(store.get(draftAtom).description.match(/screen\.png/g)).toHaveLength(
    2,
  ); // alt text and URI
  expect(store.get(draftAtom)).toMatchObject({
    pendingImages: 0,
    stagedImages: [],
    failedImages: [],
  });
  expect(stage.mock.calls[0][0]).toMatchObject({
    workspacePath: '/screenshots',
    mimeType: 'image/png',
  });
});

it('retains a failed screenshot with retry and remove actions', async () => {
  const { store, draftAtom, renderEditor, file } = harness();
  stage
    .mockRejectedValueOnce(new Error('Disk full'))
    .mockResolvedValueOnce({ relativePath: '.nimbalyst/assets/retry.png' });
  const mounted = renderEditor();
  fireEvent.change(mounted.container.querySelector('input[type=file]')!, {
    target: { files: [file] },
  });
  expect((await screen.findByRole('alert')).textContent).toContain('Disk full');
  expect(store.get(draftAtom).failedImages[0].file).toBe(file);
  fireEvent.click(screen.getByRole('button', { name: 'Retry image' }));
  await waitFor(() =>
    expect(store.get(draftAtom).description).toContain(
      '.nimbalyst/assets/retry.png',
    ),
  );
  expect(store.get(draftAtom).failedImages).toEqual([]);
});
