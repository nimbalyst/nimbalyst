/**
 * Pure helpers that turn a live Electron `Menu` into the renderer-facing
 * `SerializedMenuBar` model (see `shared/menuBar.ts`) and back again.
 *
 * Deliberately free of `electron` imports so it can be unit tested against
 * plain objects — the electron-coupled side lives in `menuBarBridge.ts`.
 */

import type {
  SerializedMenuBar,
  SerializedMenuItem,
  SerializedMenuItemType,
} from '../../shared/menuBar';

/** Structural stand-in for Electron's `MenuItem`. */
export interface MenuItemLike {
  label?: string;
  type?: string;
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean;
  accelerator?: string;
  role?: string;
  submenu?: MenuLike;
  click?: unknown;
}

/** Structural stand-in for Electron's `Menu`. */
export interface MenuLike {
  items: MenuItemLike[];
}

const MODIFIER_LABELS: Record<string, { darwin: string; other: string }> = {
  commandorcontrol: { darwin: 'Cmd', other: 'Ctrl' },
  cmdorctrl: { darwin: 'Cmd', other: 'Ctrl' },
  command: { darwin: 'Cmd', other: 'Cmd' },
  cmd: { darwin: 'Cmd', other: 'Cmd' },
  control: { darwin: 'Control', other: 'Ctrl' },
  ctrl: { darwin: 'Control', other: 'Ctrl' },
  alt: { darwin: 'Option', other: 'Alt' },
  option: { darwin: 'Option', other: 'Alt' },
  altgr: { darwin: 'AltGr', other: 'AltGr' },
  shift: { darwin: 'Shift', other: 'Shift' },
  super: { darwin: 'Super', other: 'Win' },
  meta: { darwin: 'Cmd', other: 'Win' },
};

const KEY_LABELS: Record<string, string> = {
  plus: '+',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  return: 'Enter',
  enter: 'Enter',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Esc',
  esc: 'Esc',
  numadd: 'Num+',
  numsub: 'Num-',
  nummult: 'Num*',
  numdiv: 'Num/',
  numdec: 'Num.',
};

/**
 * Render an Electron accelerator for display. Electron parses accelerators
 * itself — this is cosmetic only, so an unrecognized token is passed through
 * rather than dropped.
 */
export function formatAcceleratorLabel(
  accelerator: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (!accelerator) return undefined;
  const trimmed = accelerator.trim();
  if (!trimmed) return undefined;

  // "Plus" is the escape hatch for a literal +, so it can't be a separator.
  const tokens = trimmed.split('+').filter((token) => token.length > 0);
  const labels = tokens.map((token) => {
    const key = token.toLowerCase();
    const modifier = MODIFIER_LABELS[key];
    if (modifier) return platform === 'darwin' ? modifier.darwin : modifier.other;
    const named = KEY_LABELS[key];
    if (named) return named;
    if (key.length === 1) return token.toUpperCase();
    // Function keys and the like already arrive in display form.
    return token;
  });

  return labels.join('+');
}

function normalizeType(item: MenuItemLike): SerializedMenuItemType {
  if (item.type === 'separator') return 'separator';
  if (item.type === 'checkbox') return 'checkbox';
  if (item.type === 'radio') return 'radio';
  if (item.submenu && item.submenu.items.length > 0) return 'submenu';
  return 'normal';
}

/**
 * Hidden items leave separators stranded — a template whose whole dev-only
 * group is invisible would otherwise render a divider against nothing.
 */
function dropStrandedSeparators(items: SerializedMenuItem[]): SerializedMenuItem[] {
  const result: SerializedMenuItem[] = [];
  for (const item of items) {
    if (item.type !== 'separator') {
      result.push(item);
      continue;
    }
    if (result.length === 0) continue;
    if (result[result.length - 1].type === 'separator') continue;
    result.push(item);
  }
  while (result.length > 0 && result[result.length - 1].type === 'separator') {
    result.pop();
  }
  return result;
}

/**
 * Serialize a menu's items. `parentId` is the index path of the owning
 * submenu; ids use the item's index in the *original* array so
 * `findMenuItemByPath` can walk straight back to the live `MenuItem`.
 */
export function serializeMenuItems(
  menu: MenuLike | undefined,
  platform: NodeJS.Platform,
  parentId = '',
): SerializedMenuItem[] {
  if (!menu?.items) return [];

  const serialized: SerializedMenuItem[] = [];
  menu.items.forEach((item, index) => {
    if (item.visible === false) return;

    const id = parentId ? `${parentId}.${index}` : `${index}`;
    const type = normalizeType(item);
    const entry: SerializedMenuItem = {
      id,
      label: item.label ?? '',
      type,
      enabled: item.enabled !== false,
    };

    const acceleratorLabel = formatAcceleratorLabel(item.accelerator, platform);
    if (acceleratorLabel) entry.acceleratorLabel = acceleratorLabel;
    if (type === 'checkbox' || type === 'radio') entry.checked = item.checked === true;
    if (type === 'submenu') {
      entry.submenu = serializeMenuItems(item.submenu, platform, id);
    }

    serialized.push(entry);
  });

  return dropStrandedSeparators(serialized);
}

export function serializeMenuBar(
  menu: MenuLike | null | undefined,
  platform: NodeJS.Platform,
  revision: number,
): SerializedMenuBar {
  return {
    revision,
    inWindow: platform !== 'darwin',
    items: serializeMenuItems(menu ?? undefined, platform),
  };
}

const PATH_PATTERN = /^\d+(\.\d+)*$/;

/** Resolve an index-path id back to the live menu item, or null. */
export function findMenuItemByPath(
  menu: MenuLike | null | undefined,
  id: string,
): MenuItemLike | null {
  if (!menu || !PATH_PATTERN.test(id)) return null;

  let items: MenuItemLike[] | undefined = menu.items;
  let found: MenuItemLike | null = null;

  for (const segment of id.split('.')) {
    if (!items) return null;
    const item: MenuItemLike | undefined = items[Number(segment)];
    if (!item) return null;
    found = item;
    items = item.submenu?.items;
  }

  return found;
}
