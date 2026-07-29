/**
 * Wire model for the in-window menu bar.
 *
 * macOS draws the application menu in the system menu bar, but Windows and
 * Linux workspace windows use a frameless title bar (see `windowChrome.ts`), so
 * the native menu strip is hidden there. The renderer draws its own strip from
 * this model instead of the menu template being duplicated in the renderer —
 * `ApplicationMenu.ts` stays the single source of truth.
 *
 * Item ids are index paths into the live `Menu` ("2.4.1"), so they are only
 * valid for the revision they were serialized with. Every rebuild bumps
 * `revision`; an invoke carrying a stale revision is rejected rather than
 * firing whichever item happens to sit at that index now.
 */

export const WINDOW_MENU_CHANNELS = {
  get: 'window-menu:get',
  invoke: 'window-menu:invoke',
  changed: 'window-menu:changed',
} as const;

export type SerializedMenuItemType =
  | 'normal'
  | 'separator'
  | 'submenu'
  | 'checkbox'
  | 'radio';

export interface SerializedMenuItem {
  /** Index path into the application menu, e.g. "2.4.1". */
  id: string;
  label: string;
  type: SerializedMenuItemType;
  enabled: boolean;
  checked?: boolean;
  /** Platform-formatted accelerator for display only, e.g. "Ctrl+Shift+P". */
  acceleratorLabel?: string;
  submenu?: SerializedMenuItem[];
}

export interface SerializedMenuBar {
  revision: number;
  /**
   * Whether this platform draws the menu bar inside the window. False on
   * macOS, where the system menu bar already shows it — the model is still
   * served there so the bridge stays exercisable from any platform.
   */
  inWindow: boolean;
  items: SerializedMenuItem[];
}

export const EMPTY_MENU_BAR: SerializedMenuBar = {
  revision: 0,
  inWindow: false,
  items: [],
};
