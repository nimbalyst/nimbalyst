import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import {
  MAIN_WINDOW_TITLE_BAR_HEIGHT,
  isTitleBarOverlayColors,
  type TitleBarOverlayColors,
} from '../../shared/windowChrome';

export interface CustomTitleBarOptionsInput {
  platform: NodeJS.Platform;
  overlayColors: TitleBarOverlayColors;
}

export interface WindowTitleBarOptionsInput extends CustomTitleBarOptionsInput {
  customTitleBar: boolean;
}

type OverlayWindow = Pick<BrowserWindow, 'id' | 'isDestroyed' | 'once' | 'setTitleBarOverlay'>;

interface RegisteredOverlayWindow {
  platform: NodeJS.Platform;
  window: OverlayWindow;
}

const overlayWindows = new Map<number, RegisteredOverlayWindow>();
let resolvedOverlayColors: TitleBarOverlayColors | null = null;

export function customTitleBarOptions(
  input: CustomTitleBarOptionsInput,
): Partial<BrowserWindowConstructorOptions> {
  if (input.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      titleBarOverlay: true,
      trafficLightPosition: { x: 10, y: 12 },
    };
  }

  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      ...input.overlayColors,
      height: MAIN_WINDOW_TITLE_BAR_HEIGHT,
    },
    autoHideMenuBar: true,
  };
}

export function titleBarOptionsForWindow(
  input: WindowTitleBarOptionsInput,
): Partial<BrowserWindowConstructorOptions> {
  if (!input.customTitleBar) return {};
  return customTitleBarOptions(input);
}

function applyOverlayColors(
  registered: RegisteredOverlayWindow,
  colors: TitleBarOverlayColors,
): void {
  const { platform, window } = registered;
  if (window.isDestroyed() || typeof window.setTitleBarOverlay !== 'function') return;

  try {
    window.setTitleBarOverlay(
      platform === 'darwin'
        ? colors
        : { ...colors, height: MAIN_WINDOW_TITLE_BAR_HEIGHT },
    );
  } catch (error) {
    console.error('[WindowChrome] Failed to update title-bar overlay:', error);
  }
}

function applyColorsToRegisteredWindows(colors: TitleBarOverlayColors): void {
  for (const registered of overlayWindows.values()) {
    applyOverlayColors(registered, colors);
  }
}

export function registerCustomTitleBarWindow(
  window: OverlayWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  overlayWindows.set(window.id, { platform, window });
  window.once('closed', () => {
    overlayWindows.delete(window.id);
  });
}

export function getTitleBarOverlayColors(
  fallback: TitleBarOverlayColors,
): TitleBarOverlayColors {
  return resolvedOverlayColors ?? fallback;
}

export function setResolvedTitleBarOverlayColors(payload: unknown): boolean {
  if (!isTitleBarOverlayColors(payload)) return false;
  resolvedOverlayColors = {
    color: payload.color.trim(),
    symbolColor: payload.symbolColor.trim(),
  };
  applyColorsToRegisteredWindows(resolvedOverlayColors);
  return true;
}

export function resetTitleBarOverlayColors(fallback: TitleBarOverlayColors): void {
  resolvedOverlayColors = null;
  applyColorsToRegisteredWindows(fallback);
}

export function resetWindowChromeStateForTests(): void {
  resolvedOverlayColors = null;
  overlayWindows.clear();
}
