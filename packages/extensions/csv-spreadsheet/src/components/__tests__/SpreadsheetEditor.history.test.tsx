import { forwardRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorHostProps } from '../../types';
import type { DiffConfig } from '@nimbalyst/extension-sdk';

const { getProviders, lifecycleOptions } = vi.hoisted(() => ({
  getProviders: vi.fn(async () => ({})),
  // The editor drives diff mode entirely through the lifecycle callbacks, so
  // capturing them is how a test gets to drive it.
  lifecycleOptions: {
    current: null as null | {
      onDiffRequested: (config: DiffConfig) => void;
      onSave: () => Promise<void>;
    },
  },
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
      isLoading: false,
      error: null,
      theme: 'light',
      markDirty: vi.fn(),
    };
  },
  useCollaborativeEditor: () => ({ isCollaborative: false }),
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
