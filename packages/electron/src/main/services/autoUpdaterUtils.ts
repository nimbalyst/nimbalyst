/**
 * Pure utility functions for the auto-update service.
 *
 * Lives in its own file so unit tests can import these without pulling in
 * autoUpdater.ts's Electron-app dependencies (`app.getPath`, `safeHandle`,
 * etc.) which crash at module-load time in a vitest environment with no
 * real Electron `app` global. The test file
 * `__tests__/autoUpdater.classifyUpdateError.test.ts` imports from here
 * instead of from `autoUpdater.ts`. See nimbalyst#245.
 */

/**
 * Categorize update download duration for analytics.
 */
export function categorizeDownloadDuration(durationMs: number): 'fast' | 'medium' | 'slow' {
  if (durationMs < 30000) return 'fast';
  if (durationMs < 120000) return 'medium';
  return 'slow';
}

/**
 * Classify update errors for analytics and toast handling.
 *
 * Branch order matters: a network error mentioning "cannot be executed"
 * stays classified as network. Documents the precedence so a future
 * reorder does not silently change behavior.
 */
// electron-updater runs its requests through Electron's Chromium net stack,
// which reports connectivity failures as `net::ERR_*` strings that none of the
// Node-style checks (enotfound / econnrefused / timeout) match. The most common
// one is `net::ERR_NAME_NOT_RESOLVED` on a background poll when DNS is briefly
// unavailable (machine waking, captive portal, VPN flap). Match the connectivity
// family explicitly so these get the 'network' bucket and the background-poll
// toast suppression in autoUpdater.ts fires. Deliberately scoped: `net::ERR_CERT_*`
// and `net::ERR_SSL_*` are NOT listed here so they keep falling through to the
// signature branch below. See #56 / #223.
const CHROMIUM_NETWORK_ERROR =
  /net::err_(name_not_resolved|internet_disconnected|network_changed|connection_(refused|reset|closed|timed_out|aborted|failed)|proxy_connection_failed|address_unreachable|name_resolution_failed|network_access_denied|timed_out)/;

export function classifyUpdateError(error: Error): string {
  const message = error.message.toLowerCase();
  if (
    message.includes('network') ||
    message.includes('enotfound') ||
    message.includes('timeout') ||
    message.includes('econnrefused') ||
    CHROMIUM_NETWORK_ERROR.test(message)
  ) {
    return 'network';
  }
  if (message.includes('permission') || message.includes('eacces')) {
    return 'permission';
  }
  if (message.includes('disk') || message.includes('space') || message.includes('enospc')) {
    return 'disk_space';
  }
  if (message.includes('signature') || message.includes('verify') || message.includes('certificate') || message.includes('cert')) {
    return 'signature';
  }
  // Squirrel.Mac NSException surfaced after the download proxy is torn down
  // before `quitAndInstall` runs. Classify it as its own type so the renderer
  // toast can show a "restart manually" instruction instead of the generic
  // failure message that previously left users stuck. See #245.
  if (message.includes('command is disabled') || message.includes('cannot be executed')) {
    return 'squirrel_install_disabled';
  }
  return 'unknown';
}

/**
 * Antivirus on Windows often holds a transient handle on the freshly-downloaded
 * installer, causing electron-updater's temp -> final rename to fail with EPERM
 * (occasionally EBUSY). Detect those errors so the caller can retry once.
 */
export function isWindowsRenameLockError(err: Error): boolean {
  if (process.platform !== 'win32') return false;
  const msg = err.message || '';
  if (/\bEPERM\b.*\brename\b/i.test(msg)) return true;
  if (/\bEBUSY\b/i.test(msg)) return true;
  return false;
}
