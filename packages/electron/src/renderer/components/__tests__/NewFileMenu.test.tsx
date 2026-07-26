// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';

// Keep it a unit test: MaterialSymbol only needs to surface its icon name.
vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

import { NewFileMenu } from '../NewFileMenu';

afterEach(() => cleanup());

const baseProps = { x: 120, y: 120, onSelect: () => {}, onClose: () => {} };

function rows() {
  return Array.from(document.querySelectorAll('.new-file-menu-item')) as HTMLElement[];
}

describe('NewFileMenu', () => {
  it('renders every row as a keyboard-accessible menuitem button', () => {
    render(<NewFileMenu {...baseProps} extensionFileTypes={[]} />);
    const items = rows();
    expect(items.length).toBeGreaterThan(0);
    for (const el of items) {
      expect(el.tagName).toBe('BUTTON');
      expect(el.getAttribute('role')).toBe('menuitem');
    }
  });

  it('keeps the arbitrary "New File..." (any type) path and dispatches it', () => {
    const onSelect = vi.fn();
    render(<NewFileMenu {...baseProps} onSelect={onSelect} />);
    const anyItem = rows().find((el) => /New File\.\.\./.test(el.textContent || ''));
    expect(anyItem).toBeTruthy();
    fireEvent.click(anyItem!);
    expect(onSelect).toHaveBeenCalledWith('any');
  });

  it('shows New Folder only when onNewFolder is provided, and invokes it', () => {
    const onNewFolder = vi.fn();
    const { rerender } = render(<NewFileMenu {...baseProps} />);
    expect(document.querySelector('.new-folder-menu-item')).toBeNull();

    rerender(<NewFileMenu {...baseProps} onNewFolder={onNewFolder} />);
    const folder = document.querySelector('.new-folder-menu-item') as HTMLElement;
    expect(folder).not.toBeNull();
    expect(folder.tagName).toBe('BUTTON');
    fireEvent.click(folder);
    expect(onNewFolder).toHaveBeenCalledTimes(1);
  });
});
