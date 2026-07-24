import { describe, it, expect } from 'vitest';
// Import from the pure-utility file, NOT from autoUpdater.ts. The latter
// transitively imports `app.getPath()` and `safeHandle` IPC registrations
// that crash at module-load time in a vitest environment without a real
// Electron app global. CI caught this on the first push - prior to the
// extraction, this test file was the only failed file across 229 passing
// tests. See #245.
import { classifyUpdateError } from '../autoUpdaterUtils';

// Regression coverage for nimbalyst#245. adambhenry reported the auto-update
// flow failing on macOS arm64 with "The command is disabled and cannot be
// executed" right after the download finished. Root cause: the previous
// `checkAndDownloadLatest` called `autoUpdater.checkForUpdates()` immediately
// before `downloadUpdate()` to "get the absolute latest version", but on
// macOS each `checkForUpdates()` spins up a new Squirrel.Mac proxy server
// and the new proxy tears down the prior one that Squirrel's SQRLUpdater
// was already holding a reference to. By the time `quitAndInstall` ran the
// proxy was closed and Squirrel raised an NSException ("command is disabled").
//
// The fix has two parts:
//   1. Drop the double-check inside checkAndDownloadLatest so the proxy
//      lifecycle stays intact.
//   2. Surface the NSException via a dedicated `squirrel_install_disabled`
//      error type so the UI / analytics can distinguish it from the generic
//      "unknown" bucket and (eventually) show a "restart manually" toast.
//
// This test pins the classifier so the toast handling can rely on the new
// error category.

describe('classifyUpdateError (issue #245)', () => {
  it('classifies Squirrel.Mac NSException as squirrel_install_disabled', () => {
    // The exact NSException message string Squirrel raises when the
    // download proxy is torn down before quitAndInstall.
    const err = new Error('The command is disabled and cannot be executed.');
    expect(classifyUpdateError(err)).toBe('squirrel_install_disabled');
  });

  it('also matches the partial "cannot be executed" phrase', () => {
    // Some Electron / electron-updater versions wrap or reformat the
    // NSException. Match on either the full phrase or the trailing
    // "cannot be executed" alone so future wrapping does not silently
    // re-bucket the failure into "unknown".
    const err = new Error('Squirrel: cannot be executed.');
    expect(classifyUpdateError(err)).toBe('squirrel_install_disabled');
  });

  it('preserves existing network classification', () => {
    expect(classifyUpdateError(new Error('ENOTFOUND github.com'))).toBe('network');
    expect(classifyUpdateError(new Error('Request timeout'))).toBe('network');
    expect(classifyUpdateError(new Error('ECONNREFUSED'))).toBe('network');
  });

  // electron-updater runs through Electron's Chromium net stack, which reports
  // connectivity failures as `net::ERR_*` strings the Node-style checks above
  // miss. These were previously bucketed as 'unknown', so the background-poll
  // toast suppression in autoUpdater.ts (gated on errorType === 'network')
  // never fired and users saw an "Update Error: net::ERR_NAME_NOT_RESOLVED"
  // toast from a transient DNS blip. See #56 / #223.
  it('classifies Chromium net:: connectivity errors as network', () => {
    // DNS family (the reported error and its siblings)
    expect(classifyUpdateError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_NAME_RESOLUTION_FAILED'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_DNS_TIMED_OUT'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_DNS_SERVER_FAILED'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_ICANN_NAME_COLLISION'))).toBe('network');
    // Connectivity / network-state family
    expect(classifyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_NETWORK_CHANGED'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_NETWORK_IO_SUSPENDED'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_CONNECTION_REFUSED'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_CONNECTION_TIMED_OUT'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_PROXY_CONNECTION_FAILED'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_ADDRESS_UNREACHABLE'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_SOCKET_NOT_CONNECTED'))).toBe('network');
    expect(classifyUpdateError(new Error('net::ERR_TIMED_OUT'))).toBe('network');
  });

  it('keeps net::ERR_CERT_* / net::ERR_SSL_* as signature, not network', () => {
    // The Chromium-net branch must NOT swallow certificate/TLS failures - those
    // still belong in the signature bucket. Branch order (network before
    // signature) makes this a real risk if the net:: match were too broad.
    expect(classifyUpdateError(new Error('net::ERR_CERT_AUTHORITY_INVALID'))).toBe('signature');
    expect(classifyUpdateError(new Error('net::ERR_CERT_DATE_INVALID'))).toBe('signature');
  });

  it('preserves existing permission classification', () => {
    expect(classifyUpdateError(new Error('EACCES: permission denied'))).toBe('permission');
  });

  it('preserves existing disk_space classification', () => {
    expect(classifyUpdateError(new Error('ENOSPC: no space left on device'))).toBe('disk_space');
  });

  it('preserves existing signature classification', () => {
    expect(classifyUpdateError(new Error('Signature verification failed'))).toBe('signature');
    expect(classifyUpdateError(new Error('Certificate is invalid'))).toBe('signature');
  });

  it('returns "unknown" for unrelated errors', () => {
    expect(classifyUpdateError(new Error('Something else went wrong'))).toBe('unknown');
    expect(classifyUpdateError(new Error('Update failed for unknown reason'))).toBe('unknown');
  });

  it('classifies before the catch-all - network beats squirrel if both terms appear', () => {
    // Order of branches: network > permission > disk > signature > squirrel.
    // A "network" error mentioning "cannot be executed" should still be
    // categorized as network. This documents the precedence so a future
    // reorder does not silently change behaviour.
    const err = new Error('Network timeout - command is disabled');
    expect(classifyUpdateError(err)).toBe('network');
  });
});
