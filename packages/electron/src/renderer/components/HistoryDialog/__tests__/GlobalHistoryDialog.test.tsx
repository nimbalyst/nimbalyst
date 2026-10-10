// @vitest-environment jsdom
/**
 * A personal page snapshot restores through the page's body save at the
 * current version, never as a file write of its `personal-doc://` key.
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider, createStore } from 'jotai';

const dialog = vi.hoisted(() => ({ onRestore: null as null | ((content: string) => Promise<void> | void) }));
vi.mock('../HistoryDialog', () => ({
  HistoryDialog: (props: { onRestore: (content: string) => Promise<void> }) => {
    dialog.onRestore = props.onRestore;
    return null;
  },
}));
vi.mock('../CollabHistoryDialog', () => ({ CollabHistoryDialog: () => null }));
const showError = vi.hoisted(() => vi.fn());
vi.mock('../../../services/ErrorNotificationService', () => ({ errorNotificationService: { showError } }));

import { GlobalHistoryDialog } from '../GlobalHistoryDialog';
import { historyDialogFileAtom } from '../../../store';

beforeEach(() => {
  dialog.onRestore = null;
  (window as any).electronAPI = { saveFile: vi.fn() };
});

describe('GlobalHistoryDialog restore', () => {
  it('restores a personal page snapshot through its body save, never as a file', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'personal-pages:get-body') return { content: '# Now', version: 4 };
      if (channel === 'personal-pages:update-body') return { version: 5 };
      throw new Error(`unexpected ${channel}`);
    });
    (window as any).electronAPI.invoke = invoke;
    const store = createStore();
    store.set(historyDialogFileAtom, 'personal-doc://pdoc-1');
    render(<Provider store={store}><GlobalHistoryDialog theme="light" workspacePath="/ws" /></Provider>);

    await dialog.onRestore!('# Old');
    expect(invoke).toHaveBeenCalledWith('personal-pages:update-body', '/ws', 'pdoc-1', '# Old', 4);
    expect((window as any).electronAPI.saveFile).not.toHaveBeenCalled();
    expect(store.get(historyDialogFileAtom)).toBeNull();
  });

  it('restores a Personal typed page body as a tracker body write, never as a file', async () => {
    const updateTrackerItemContent = vi.fn(async () => ({ success: true }));
    (window as any).electronAPI.documentService = {
      getTrackerBodyCacheForDetail: async () => ({ success: true, row: { content: '# Now', bodyVersion: 6 } }),
      updateTrackerItemContent,
    };
    const store = createStore();
    store.set(historyDialogFileAtom, 'personal-doc://tracker-content/idea_1');
    render(<Provider store={store}><GlobalHistoryDialog theme="light" workspacePath="/ws" /></Provider>);

    await dialog.onRestore!('# Old');
    expect(updateTrackerItemContent).toHaveBeenCalledWith({ itemId: 'idea_1', content: '# Old', expectedBodyVersion: 6 });
    expect((window as any).electronAPI.saveFile).not.toHaveBeenCalled();
  });

  it('tells the person when a restore was refused because the page changed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as any).electronAPI.documentService = {
      getTrackerBodyCacheForDetail: async () => ({ success: true, row: { content: '# Now', bodyVersion: 6 } }),
      updateTrackerItemContent: async () => ({ success: false, conflict: true, bodyVersion: 7 }),
    };
    const store = createStore();
    store.set(historyDialogFileAtom, 'personal-doc://tracker-content/idea_1');
    render(<Provider store={store}><GlobalHistoryDialog theme="light" workspacePath="/ws" /></Provider>);

    await dialog.onRestore!('# Old');
    expect(showError).toHaveBeenCalledWith('Version not restored', expect.stringMatching(/changed while restoring/));
  });

  it('still writes an ordinary file path to disk', async () => {
    const store = createStore();
    store.set(historyDialogFileAtom, '/ws/a.md');
    render(<Provider store={store}><GlobalHistoryDialog theme="light" workspacePath="/ws" /></Provider>);

    await dialog.onRestore!('# Old');
    expect((window as any).electronAPI.saveFile).toHaveBeenCalledWith('# Old', '/ws/a.md');
  });
});
