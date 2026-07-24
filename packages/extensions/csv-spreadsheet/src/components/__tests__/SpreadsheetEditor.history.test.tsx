import { forwardRef } from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorHostProps } from '../../types';

const { getProviders } = vi.hoisted(() => ({
  getProviders: vi.fn(async () => ({})),
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
  useEditorLifecycle: () => ({
    isLoading: false,
    error: null,
    theme: 'light',
    markDirty: vi.fn(),
  }),
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
  } as unknown as EditorHostProps['host'];
}

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
