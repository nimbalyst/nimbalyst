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
  /net::err_(name_not_resolved|name_resolution_failed|dns_\w+|icann_name_collision|internet_disconnected|network_\w+|connection_\w+|proxy_connection_failed|address_unreachable|socket_not_connected|timed_out)/;

/**
 * Classify update errors for analytics and toast handling.
 *
 * Branch order matters: a network error mentioning "cannot be executed"
 * stays classified as network. Documents the precedence so a future
 * reorder does not silently change behavior.
 */
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
  // Release-in-flight 404: the GitHub release workflow pushes the tag before
  // it uploads `latest-mac.yml` / `latest.yml` / `latest-linux.yml`, so any
  // client polling during the build window asks for a metadata file that
  // doesn't exist yet and electron-updater surfaces an HttpError 404. Same
  // shape applies if a tag gets pushed without a published Release. This is
  // functionally identical to "no update available" from the user's point of
  // view and must NOT raise a toast on the hourly background poll. See #56
  // (network suppression pattern) and the v0.63.2 release-day incident.
  if (
    /cannot find latest-(mac|linux)?\.?ya?ml/.test(message) ||
    /httperror:\s*404/.test(message)
  ) {
    return 'release_pending';
  }
  return 'unknown';
}

/**
 * Dedup state for the two update analytics events that are driven by the hourly
 * poll rather than by anything the user did.
 *
 * Kept as a plain value with pure transitions so the emission decision can be
 * unit-tested without an Electron app global or a fake clock -- the same reason
 * `classifyUpdateError` lives in this file. See
 * `__tests__/autoUpdater.analyticsDedup.test.ts`.
 */
export interface UpdateAnalyticsState {
  /** Version whose `update-downloaded` we have already reported. */
  readonly lastDownloadedVersion: string | null;
  /** `${stage}:${errorType}` we have already reported. */
  readonly lastErrorKey: string | null;
}

export const EMPTY_UPDATE_ANALYTICS_STATE: UpdateAnalyticsState = {
  lastDownloadedVersion: null,
  lastErrorKey: null,
};

export interface EmitPlan {
  readonly emit: boolean;
  readonly next: UpdateAnalyticsState;
}

/**
 * Whether to report `update_download_completed` for `version`.
 *
 * electron-updater caches the installer and re-emits `update-downloaded` from
 * cache on every poll once a download is pending (`validateDownloadedPath`
 * short-circuits to `done(false)` in AppUpdater). With an hourly poll that is
 * one event per hour of uptime for as long as the user postpones the restart,
 * which is where 474,881 events across 5,376 users came from. Report the first
 * completion per version and stay quiet until a newer version supersedes it.
 */
export function planDownloadCompletedEmit(state: UpdateAnalyticsState, version: string): EmitPlan {
  if (state.lastDownloadedVersion === version) return { emit: false, next: state };
  return { emit: true, next: { ...state, lastDownloadedVersion: version } };
}

/**
 * Whether to report `update_error` for this failure.
 *
 * Deliberately once per (stage, errorType) for the whole process lifetime. The
 * previous guard cleared its key on every *successful* check, so the common
 * real-world pattern -- a network that flaps between polls -- re-armed it every
 * hour and produced 182,624 events. We want to know that a user hit an error
 * class at all, not how many times the poll retried it.
 */
export function planUpdateErrorEmit(
  state: UpdateAnalyticsState,
  stage: string,
  errorType: string,
): EmitPlan {
  const key = `${stage}:${errorType}`;
  if (state.lastErrorKey === key) return { emit: false, next: state };
  return { emit: true, next: { ...state, lastErrorKey: key } };
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
