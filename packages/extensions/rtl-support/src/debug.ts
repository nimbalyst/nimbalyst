/**
 * debug — logging utility gated behind a flag.
 *
 * To enable:
 *   localStorage.setItem('nimbalyst.rtl-support.debug', 'true')
 *   or window.nimbalystRtlSupport.updateSettings({ debug: true })
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

/** Set the debug flag manually (from settings API) */
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

/** Whether debug is enabled */
export function isDebug(): boolean {
  return readDebug();
}

/** Log only when debug is enabled */
export function debug(...args: unknown[]): void {
  if (readDebug()) {
    console.log('[RTL Support]', ...args);
  }
}

/** Errors are always logged */
export function error(...args: unknown[]): void {
  console.error('[RTL Support]', ...args);
}
