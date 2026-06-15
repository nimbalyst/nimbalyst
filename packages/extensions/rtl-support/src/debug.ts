/**
 * debug — logging utility که با flag کنترل می‌شه.
 *
 * برای فعال‌سازی:
 *   localStorage.setItem('nimbalyst.rtl-support.debug', 'true')
 *   یا window.nimbalystRtlSupport.updateSettings({ debug: true })
 */

const DEBUG_KEY = 'nimbalyst.rtl-support.debug';

let cachedDebug: boolean | null = null;

function readDebug(): boolean {
  if (cachedDebug !== null) return cachedDebug;
  if (typeof localStorage === 'undefined') return false;
  try {
    cachedDebug = localStorage.getItem(DEBUG_KEY) === 'true';
  } catch {
    cachedDebug = false;
  }
  return cachedDebug;
}

/** تنظیم دستی debug flag (از settings API) */
export function setDebug(enabled: boolean): void {
  cachedDebug = enabled;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(DEBUG_KEY, String(enabled));
    } catch {
      // ignore
    }
  }
}

/** آیا debug فعال است؟ */
export function isDebug(): boolean {
  return readDebug();
}

/** لاگ فقط وقتی debug فعال باشه */
export function debug(...args: unknown[]): void {
  if (readDebug()) {
    console.log('[RTL Support]', ...args);
  }
}

/** خطا همیشه لاگ می‌شه */
export function error(...args: unknown[]): void {
  console.error('[RTL Support]', ...args);
}
