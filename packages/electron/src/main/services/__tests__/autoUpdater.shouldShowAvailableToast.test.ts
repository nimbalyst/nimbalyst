import { describe, it, expect } from 'vitest';
// Pure-utility import, NOT from autoUpdater.ts. The latter loads
// `app.getPath()` and `safeHandle` at module construction time and crashes
// in vitest without a real Electron app global. Same pattern as
// `autoUpdater.classifyUpdateError.test.ts`. See nimbalyst#245.
import { shouldShowAvailableToast } from '../autoUpdaterUtils';

// Regression coverage for nimbalyst#245 follow-up to #314. Greg merged #314
// with the bare-bones single-check fix and said "I'll accept this to avoid
// the error conditions, but plan to move toward auto-download in the
// future." This is that follow-up: `autoUpdater.autoDownload = true` so the
// background poll silently downloads, and the `update-toast:show-available`
// toast is gated to only fire on the manual "Check for Updates" path.
//
// Without the gate, the auto-poll path would still fire the "Update
// available, click Download" toast even though the download has already
// started -- the user would click Download and electron-updater would
// re-enter downloadUpdate() while a download was already in flight.

describe('shouldShowAvailableToast (issue #245 follow-up to #314)', () => {
  it('returns true on a manual "Check for Updates" click', () => {
    // Manual check path: user explicitly asked, surface the "found one" toast
    // so the click gets feedback. The renderer transitions through 'available'
    // -> 'downloading' -> 'ready' as the autoDownload progress events arrive.
    expect(shouldShowAvailableToast(true)).toBe(true);
  });

  it('returns false on a background-poll update-available event', () => {
    // Background-poll path under `autoDownload = true`: the download starts
    // on its own. The user does not need the "click Download" toast; they
    // only see the post-download "Ready to install" toast.
    expect(shouldShowAvailableToast(false)).toBe(false);
  });

  it('treats the boolean argument as a direct gate, no other state read', () => {
    // The function is intentionally a one-arg pure function. Pin that so a
    // future "also factor in suppression" rework has to touch this test and
    // the caller together, not silently broaden the policy.
    expect(shouldShowAvailableToast(true)).not.toBe(shouldShowAvailableToast(false));
  });
});
