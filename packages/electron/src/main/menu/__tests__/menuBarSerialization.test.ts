import { describe, expect, it } from 'vitest';
import {
  findMenuItemByPath,
  formatAcceleratorLabel,
  serializeMenuBar,
  serializeMenuItems,
  type MenuLike,
} from '../menuBarSerialization';

function menu(items: MenuLike['items']): MenuLike {
  return { items };
}

describe('formatAcceleratorLabel', () => {
  it('renders CmdOrCtrl as Ctrl off macOS and Cmd on it', () => {
    expect(formatAcceleratorLabel('CmdOrCtrl+Shift+P', 'win32')).toBe('Ctrl+Shift+P');
    expect(formatAcceleratorLabel('CmdOrCtrl+Shift+P', 'darwin')).toBe('Cmd+Shift+P');
  });

  it('maps Alt to Option only on macOS', () => {
    expect(formatAcceleratorLabel('Alt+Left', 'win32')).toBe('Alt+Left');
    expect(formatAcceleratorLabel('Alt+Left', 'darwin')).toBe('Option+Left');
  });

  it('keeps function keys and passes through the Plus escape hatch', () => {
    expect(formatAcceleratorLabel('F12', 'win32')).toBe('F12');
    expect(formatAcceleratorLabel('CmdOrCtrl+Plus', 'win32')).toBe('Ctrl++');
  });

  it('returns undefined for a missing or blank accelerator', () => {
    expect(formatAcceleratorLabel(undefined, 'win32')).toBeUndefined();
    expect(formatAcceleratorLabel('   ', 'win32')).toBeUndefined();
  });
});

describe('serializeMenuItems', () => {
  it('ids items by their index path so they resolve back to the live menu', () => {
    const source = menu([
      {
        label: 'File',
        submenu: menu([
          { label: 'Save', accelerator: 'CmdOrCtrl+S' },
          {
            label: 'New',
            submenu: menu([{ label: 'Document' }]),
          },
        ]),
      },
      { label: 'Edit', submenu: menu([{ label: 'Undo', role: 'undo' }]) },
    ]);

    const items = serializeMenuItems(source, 'win32');

    expect(items.map((item) => item.id)).toEqual(['0', '1']);
    expect(items[0].type).toBe('submenu');
    expect(items[0].submenu?.[0]).toMatchObject({
      id: '0.0',
      label: 'Save',
      type: 'normal',
      acceleratorLabel: 'Ctrl+S',
    });
    expect(items[0].submenu?.[1].submenu?.[0].id).toBe('0.1.0');

    expect(findMenuItemByPath(source, '0.1.0')?.label).toBe('Document');
    expect(findMenuItemByPath(source, '1.0')?.role).toBe('undo');
  });

  it('skips hidden items but keeps ids aligned with the live indices', () => {
    const source = menu([
      {
        label: 'View',
        submenu: menu([
          { label: 'Zoom In' },
          { label: 'Debug Only', visible: false },
          { label: 'Zoom Out' },
        ]),
      },
    ]);

    const submenu = serializeMenuItems(source, 'win32')[0].submenu ?? [];

    expect(submenu.map((item) => item.label)).toEqual(['Zoom In', 'Zoom Out']);
    expect(submenu.map((item) => item.id)).toEqual(['0.0', '0.2']);
    expect(findMenuItemByPath(source, '0.2')?.label).toBe('Zoom Out');
  });

  it('drops separators left stranded by hidden items', () => {
    const source = menu([
      {
        label: 'Help',
        submenu: menu([
          { type: 'separator' },
          { label: 'Docs' },
          { type: 'separator' },
          { label: 'Dev Only', visible: false },
          { type: 'separator' },
          { label: 'About' },
          { type: 'separator' },
        ]),
      },
    ]);

    const submenu = serializeMenuItems(source, 'win32')[0].submenu ?? [];

    expect(submenu.map((item) => item.type)).toEqual([
      'normal',
      'separator',
      'normal',
    ]);
    expect(submenu.map((item) => item.label)).toEqual(['Docs', '', 'About']);
  });

  it('reports enabled and checked state', () => {
    const items = serializeMenuItems(
      menu([
        {
          label: 'View',
          submenu: menu([
            { label: 'Dark', type: 'radio', checked: true },
            { label: 'Light', type: 'radio', checked: false },
            { label: 'Unavailable', enabled: false },
          ]),
        },
      ]),
      'win32',
    );

    expect(items[0].submenu).toMatchObject([
      { label: 'Dark', type: 'radio', checked: true, enabled: true },
      { label: 'Light', type: 'radio', checked: false },
      { label: 'Unavailable', type: 'normal', enabled: false },
    ]);
  });

  it('treats an empty submenu as a normal item', () => {
    const items = serializeMenuItems(menu([{ label: 'Empty', submenu: menu([]) }]), 'win32');
    expect(items[0].type).toBe('normal');
  });
});

describe('serializeMenuBar', () => {
  it('carries the revision and tolerates a missing menu', () => {
    expect(serializeMenuBar(null, 'win32', 7)).toEqual({ revision: 7, inWindow: true, items: [] });
    expect(serializeMenuBar(menu([{ label: 'File' }]), 'win32', 3).revision).toBe(3);
  });

  it('marks the bar as not drawn in-window on macOS, but still serializes it', () => {
    const menuBar = serializeMenuBar(menu([{ label: 'File' }]), 'darwin', 1);

    expect(menuBar.inWindow).toBe(false);
    expect(menuBar.items).toHaveLength(1);
  });
});

describe('findMenuItemByPath', () => {
  it('rejects malformed or out-of-range paths', () => {
    const source = menu([{ label: 'File', submenu: menu([{ label: 'Save' }]) }]);

    expect(findMenuItemByPath(source, '0.9')).toBeNull();
    expect(findMenuItemByPath(source, '')).toBeNull();
    expect(findMenuItemByPath(source, 'constructor')).toBeNull();
    expect(findMenuItemByPath(source, '0..1')).toBeNull();
    expect(findMenuItemByPath(null, '0')).toBeNull();
  });
});
