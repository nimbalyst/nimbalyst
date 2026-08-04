// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { WindowMenuBar } from '../WindowMenuBar';
import { windowMenuBarAtom } from '../../../store/atoms/windowMenu';
import { EMPTY_MENU_BAR, type SerializedMenuBar } from '../../../../shared/menuBar';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => (
    <span data-icon={icon} aria-hidden="true">{icon}</span>
  ),
}));

const invokeWindowMenuItem = vi.fn().mockResolvedValue({ invoked: true });

const MENU_BAR: SerializedMenuBar = {
  revision: 4,
  inWindow: true,
  items: [
    {
      id: '0',
      label: 'File',
      type: 'submenu',
      enabled: true,
      submenu: [
        { id: '0.0', label: 'Save', type: 'normal', enabled: true, acceleratorLabel: 'Ctrl+S' },
        { id: '0.1', label: 'Save As', type: 'normal', enabled: false },
        { id: '0.2', label: '', type: 'separator', enabled: true },
        {
          id: '0.3',
          label: 'New',
          type: 'submenu',
          enabled: true,
          submenu: [{ id: '0.3.0', label: 'Document', type: 'normal', enabled: true }],
        },
      ],
    },
    {
      id: '1',
      label: 'View',
      type: 'submenu',
      enabled: true,
      submenu: [
        { id: '1.0', label: 'Dark', type: 'radio', enabled: true, checked: true },
      ],
    },
  ],
};

function renderMenuBar(menuBar: SerializedMenuBar = MENU_BAR) {
  const store = createStore();
  store.set(windowMenuBarAtom, menuBar);
  return render(
    <Provider store={store}>
      <WindowMenuBar />
    </Provider>,
  );
}

beforeEach(() => {
  invokeWindowMenuItem.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { invokeWindowMenuItem };
});

afterEach(() => cleanup());

describe('WindowMenuBar', () => {
  it('renders nothing when the model is empty', () => {
    renderMenuBar(EMPTY_MENU_BAR);
    expect(screen.queryByTestId('window-menu-bar')).toBeNull();
  });

  it('renders nothing on macOS, where the system menu bar owns the menu', () => {
    renderMenuBar({ ...MENU_BAR, inWindow: false });
    expect(screen.queryByTestId('window-menu-bar')).toBeNull();
  });

  it('renders the top-level menus with stable markers', () => {
    renderMenuBar();

    const bar = screen.getByTestId('window-menu-bar');
    expect(bar.getAttribute('data-component')).toBe('WindowMenuBar');
    expect(screen.getByTestId('window-menu-top-0').textContent).toBe('File');
    expect(screen.getByTestId('window-menu-top-1').textContent).toBe('View');
    expect(screen.queryByTestId('window-menu-dropdown-0')).toBeNull();
  });

  it('opens a menu on click and shows labels, accelerators, and separators', () => {
    renderMenuBar();

    fireEvent.click(screen.getByTestId('window-menu-top-0'));

    const dropdown = screen.getByTestId('window-menu-dropdown-0');
    expect(dropdown.textContent).toContain('Save');
    expect(dropdown.textContent).toContain('Ctrl+S');
    expect(dropdown.querySelectorAll('[role="separator"]').length).toBe(1);
    expect(screen.getByTestId('window-menu-item-0.1').getAttribute('data-disabled')).toBe('true');
  });

  it('invokes the clicked item against the revision it was rendered from', () => {
    renderMenuBar();

    fireEvent.click(screen.getByTestId('window-menu-top-0'));
    fireEvent.click(screen.getByTestId('window-menu-item-0.0'));

    expect(invokeWindowMenuItem).toHaveBeenCalledWith('0.0', 4);
    expect(screen.queryByTestId('window-menu-dropdown-0')).toBeNull();
  });

  it('does not invoke a disabled item', () => {
    renderMenuBar();

    fireEvent.click(screen.getByTestId('window-menu-top-0'));
    fireEvent.click(screen.getByTestId('window-menu-item-0.1'));

    expect(invokeWindowMenuItem).not.toHaveBeenCalled();
  });

  it('shows checked state for radio and checkbox items', () => {
    renderMenuBar();

    fireEvent.click(screen.getByTestId('window-menu-top-1'));

    const item = screen.getByTestId('window-menu-item-1.0');
    expect(item.getAttribute('role')).toBe('menuitemcheckbox');
    expect(item.getAttribute('aria-checked')).toBe('true');
    expect(item.querySelector('[data-icon="check"]')).not.toBeNull();
  });

  it('opens a submenu from its parent item', () => {
    renderMenuBar();

    fireEvent.click(screen.getByTestId('window-menu-top-0'));
    const submenuTrigger = screen.getByTestId('window-menu-item-0.3');
    expect(submenuTrigger.getAttribute('aria-haspopup')).toBe('menu');

    fireEvent.click(submenuTrigger);

    expect(screen.getByTestId('window-menu-submenu-0.3').textContent).toContain('Document');
  });

  it('switches menus on hover once one is open, but not before', () => {
    renderMenuBar();

    fireEvent.mouseEnter(screen.getByTestId('window-menu-top-1'));
    expect(screen.queryByTestId('window-menu-dropdown-1')).toBeNull();

    fireEvent.click(screen.getByTestId('window-menu-top-0'));
    fireEvent.mouseEnter(screen.getByTestId('window-menu-top-1'));

    expect(screen.queryByTestId('window-menu-dropdown-0')).toBeNull();
    expect(screen.getByTestId('window-menu-dropdown-1')).not.toBeNull();
  });
});
