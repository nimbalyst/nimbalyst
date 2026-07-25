/**
 * Cross-window lockstep for navigation-gutter customization.
 *
 * Gutter customization (hidden items + per-section order) persists through the
 * generic `app-settings:set` store, which broadcasts `app-settings:changed` to
 * every OTHER window. The rail and the Settings-panel usage-indicator toggles
 * both read `gutterCustomizationAtom`, so mirroring those broadcasts into the
 * atom keeps every window in lockstep without a reload -- e.g. clicking a usage
 * indicator's "Disable" in one window hides it in the others live.
 *
 * The value is applied directly to the atom (not through the persisting
 * setters), so it does not re-persist or echo. Main already excludes the
 * originating window from the broadcast, so a window never hears its own write.
 */
import { store } from '@nimbalyst/runtime/store';
import { gutterCustomizationAtom } from '../atoms/appSettings';
import {
  HIDDEN_GUTTER_ITEMS_KEY,
  GUTTER_ITEM_ORDER_KEY,
  type GutterCustomizationState,
} from '../../components/NavigationGutter/navGutterItems';

let listenerRegistered = false;

/**
 * Subscribe once to the `app-settings:changed` broadcast and mirror gutter
 * customization keys into `gutterCustomizationAtom`. Idempotent: subsequent
 * calls are no-ops.
 */
export function registerGutterCustomizationListener(): void {
  if (listenerRegistered) return;
  if (typeof window === 'undefined' || !window.electronAPI?.onAppSettingsChanged) return;
  listenerRegistered = true;
  window.electronAPI.onAppSettingsChanged(({ key, value }) => {
    if (key === HIDDEN_GUTTER_ITEMS_KEY) {
      const hiddenItems = Array.isArray(value) ? (value as string[]) : [];
      store.set(gutterCustomizationAtom, (prev) => ({ ...prev, hiddenItems }));
    } else if (key === GUTTER_ITEM_ORDER_KEY) {
      const order =
        value && typeof value === 'object'
          ? (value as GutterCustomizationState['order'])
          : {};
      store.set(gutterCustomizationAtom, (prev) => ({ ...prev, order }));
    }
  });
}
