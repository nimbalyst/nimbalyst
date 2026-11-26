import type { BrowserWindow } from 'electron';
import { windows } from '../window/windowState';
import { getSettingsService } from './SettingsService';
import { BrowserSessionService } from './BrowserSessionService';

const UI_SCALE_KEY = 'appearance.uiScale';

/** The configured interface scale as a zoom factor, where 1 is 100%. */
export function getUiScaleFactor(): number {
  return getSettingsService().get(UI_SCALE_KEY) / 100;
}

/** Applies the configured scale to one window and re-positions its native browser views. */
export function applyUiScale(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  window.webContents.setZoomFactor(getUiScaleFactor());
  BrowserSessionService.getInstance().refreshBoundsForWindow(window);
}

/** Applies the scale to every app window when the setting changes. Returns the unsubscribe. */
export function registerUiScale(): () => void {
  return getSettingsService().subscribe((key) => {
    if (key !== UI_SCALE_KEY) return;
    for (const window of windows.values()) applyUiScale(window);
  });
}
