import { forwardRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorHostProps } from '../../types';
import type { DiffConfig } from '@nimbalyst/extension-sdk';

const { getProviders, lifecycleOptions, lifecycleState, navigateToTrackerReference } = vi.hoisted(() => ({
  getProviders: vi.fn(async () => ({})),
  // The editor drives diff mode entirely through the lifecycle callbacks, so
  // capturing them is how a test gets to drive it.
  lifecycleOptions: {
    current: null as null | {
      onDiffRequested: (config: DiffConfig) => void;
      onSave: () => Promise<void>;
    },
  },
  /** Lets a test hold the editor in its loading state and then release it. */
  lifecycleState: { isLoading: false },
  navigateToTrackerReference: vi.fn(),
}));

vi.mock('@revolist/react-datagrid', async () => {
  const ReactModule = await import('react');

  return {
    RevoGrid: forwardRef<HTMLElement, Record<string, unknown>>((_props, ref) =>
      ReactModule.createElement('revo-grid', {
        ref: (element: HTMLElement | null) => {
          if (element) {
            Object.assign(element, {
              getProviders,
              getSource: vi.fn(async () => []),
              getSelectedRange: vi.fn(async () => null),
              setDataAt: vi.fn(),
              setCellsFocus: vi.fn(),
            });
          }

          if (typeof ref === 'function') {
            ref(element);
          } else if (ref) {
            ref.current = element;
          }
        },
      })
    ),
  };
});

vi.mock('@nimbalyst/extension-sdk', () => ({
  useEditorLifecycle: (_host: unknown, options: unknown) => {
    lifecycleOptions.current = options as typeof lifecycleOptions.current;
    return {
      isLoading: lifecycleState.isLoading,
      error: null,
      theme: 'light',
      markDirty: vi.fn(),
    };
  },
  useCollaborativeEditor: () => ({ isCollaborative: false }),
  useResolvedTrackerReference: () => null,
  navigateToTrackerReference,
  readClipboard: vi.fn(async () => ''),
}));

import { SpreadsheetEditor } from '../SpreadsheetEditor';

function createHost(): EditorHostProps['host'] {
  return {
    filePath: '/tmp/history.csv',
    fileName: 'history.csv',
    isActive: true,
    readOnly: false,
    setDirty: vi.fn(),
    setEditorContextItems: vi.fn(),
    registerEditorAPI: vi.fn(),
    saveContent: vi.fn(async () => {}),
    loadContent: vi.fn(async () => ''),
  } as unknown as EditorHostProps['host'];
}

const DIFF: DiffConfig = {
  originalContent: 'Region,Total\nNorth,1\nSouth,2\n',
  modifiedContent: 'Region,Total\nNorth,9\n',
  tagId: 'tag-1',
  sessionId: 'session-1',
};

describe('SpreadsheetEditor history lifecycle', () => {
  beforeEach(() => {
    getProviders.mockClear();
  });

  it('preserves one undo plugin when the host prop is recreated', async () => {
    const host = createHost();
    const { rerender } = render(<SpreadsheetEditor host={host} />);

    await waitFor(() => expect(getProviders).toHaveBeenCalledTimes(1));

    rerender(<SpreadsheetEditor host={{ ...host }} />);

    await waitFor(() => expect(getProviders).toHaveBeenCalledTimes(1));
  });
});

/**
 * Link and tracker cells are wired by one delegated click listener on the
 * editor root, because attaching handlers inside the hyperscript cell templates
 * would fight RevoGrid's own mousedown handling.
 *
 * That listener is attached in an effect — and the editor returns early while
 * it is loading, so on the first commit the root does not exist yet. With an
 * empty dep array the effect ran once against a null ref and never retried,
 * leaving every link and chip inert with no error anywhere. Nothing about that
 * is visible reading the component, which is why it is pinned here.
 */
describe('SpreadsheetEditor cell click delegation', () => {
  beforeEach(() => {
    navigateToTrackerReference.mockClear();
  });

  // A leaked loading state would render every later test's editor as a
  // spinner, so it is reset even when an assertion above throws.
  afterEach(() => {
    lifecycleState.isLoading = false;
  });

  /**
   * Stand in for a painted tracker chip; the mocked grid paints no cells. The
   * loading and error branches render their own `.spreadsheet-editor` div
   * *without* the ref, so the chip goes on the one that actually has the grid.
   */
  function appendChip(container: HTMLElement, itemId: string): HTMLElement {
    const root = container.querySelector('.spreadsheet-editor:has(revo-grid)');
    if (!root) throw new Error('editor root with grid not rendered');
    const chip = document.createElement('span');
    chip.setAttribute('data-csv-tracker-item', itemId);
    root.appendChild(chip);
    return chip;
  }

  it('opens the item when a tracker chip is clicked', async () => {
    const { container } = render(<SpreadsheetEditor host={createHost()} />);
    await waitFor(() => expect(container.querySelector('revo-grid')).not.toBeNull());

    appendChip(container, 'item-1').click();

    expect(navigateToTrackerReference).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'item-1' }),
    );
  });

  it('still binds when the editor mounts in its loading state first', async () => {
    lifecycleState.isLoading = true;
    const host = createHost();
    const { container, rerender } = render(<SpreadsheetEditor host={host} />);
    // The loading branch renders a placeholder with no grid and no ref, so
    // there is nothing for the effect to bind to on this commit.
    expect(container.querySelector('revo-grid')).toBeNull();

    lifecycleState.isLoading = false;
    rerender(<SpreadsheetEditor host={host} />);
    await waitFor(() => expect(container.querySelector('revo-grid')).not.toBeNull());

    appendChip(container, 'item-2').click();

    expect(navigateToTrackerReference).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'item-2' }),
    );
  });
});

/**
 * A diff splices phantom rows into the grid for the AI's deletions, so grid
 * indices stop matching the file's and every write lands on the wrong row --
 * and is discarded anyway when accept/reject reloads from disk.
 */
describe('SpreadsheetEditor diff review', () => {
  beforeEach(() => {
    lifecycleOptions.current = null;
  });

  async function renderInDiffMode() {
    const host = createHost();
    const { container } = render(<SpreadsheetEditor host={host} />);
    await waitFor(() => expect(lifecycleOptions.current).not.toBeNull());
    act(() => {
      lifecycleOptions.current!.onDiffRequested(DIFF);
    });
    return { host, container };
  }

  it('makes the formula bar read-only while a diff is under review', async () => {
    const { container } = await renderInDiffMode();

    const input = container.querySelector<HTMLInputElement>('.csv-formula-bar input');
    expect(input?.readOnly).toBe(true);
  });

  it('refuses to save while a diff is under review', async () => {
    const { host } = await renderInDiffMode();

    await act(async () => {
      await lifecycleOptions.current!.onSave();
    });

    // Saving here would write the phantom deleted rows back out as real ones.
    expect(host.saveContent).not.toHaveBeenCalled();
  });
});

describe('SpreadsheetEditor save failures', () => {
  // The echo baseline and the dirty flag used to be updated before the write
  // was awaited, so a rejected save left the editor marked clean against
  // content that never reached disk -- silent divergence with nothing to
  // retry from. The rejection has to surface instead.
  it('stays dirty when the write to disk fails', async () => {
    const host = createHost();
    (host.saveContent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));

    render(<SpreadsheetEditor host={host} />);
    await waitFor(() => expect(lifecycleOptions.current).not.toBeNull());
    (host.setDirty as ReturnType<typeof vi.fn>).mockClear();

    await expect(lifecycleOptions.current!.onSave()).rejects.toThrow('disk full');

    // markClean() drives setDirty(false). Reaching it despite a failed write is
    // what made the divergence silent.
    expect(host.setDirty).not.toHaveBeenCalledWith(false);
  });
});

describe('SpreadsheetEditor save failures', () => {
  // The echo baseline and the dirty flag used to be updated before the write
  // was awaited, so a rejected save left the editor marked clean against
  // content that never reached disk -- silent divergence with nothing to
  // retry from. The rejection has to surface instead.
  it('stays dirty when the write to disk fails', async () => {
    const host = createHost();
    (host.saveContent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));

    render(<SpreadsheetEditor host={host} />);
    await waitFor(() => expect(lifecycleOptions.current).not.toBeNull());
    (host.setDirty as ReturnType<typeof vi.fn>).mockClear();

    await expect(lifecycleOptions.current!.onSave()).rejects.toThrow('disk full');

    // markClean() drives setDirty(false). Reaching it despite a failed write is
    // what made the divergence silent.
    expect(host.setDirty).not.toHaveBeenCalledWith(false);
  });
});
