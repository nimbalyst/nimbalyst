// @vitest-environment node
import { describe, it, expect } from 'vitest';

// Import from the pure-utility file, NOT from autoUpdater.ts, which crashes at
// module load in vitest without a real Electron `app` global. See #245.
import {
  EMPTY_UPDATE_ANALYTICS_STATE,
  planDownloadCompletedEmit,
  planUpdateErrorEmit,
} from '../autoUpdaterUtils';

// Regression coverage for the update analytics volume blow-out measured on
// 2026-09-04: `update_download_completed` fired 474,881 times across 5,376
// users in 30 days (~88 each) and `update_error` 182,624 times.
//
// Neither was a download problem. electron-updater caches the installer and
// re-emits `update-downloaded` from cache on every poll
// (AppUpdater.js validateDownloadedPath -> done(false)), and the service polls
// hourly. So a user who leaves an update pending emits one event per hour of
// uptime, forever. The `update_error` guard had the mirror-image bug: it keyed
// on (stage, error_type) but the key was cleared on every *successful* check,
// so a flapping network re-armed it every poll.
describe('update_download_completed dedup', () => {
  it('emits the first time a version finishes downloading', () => {
    const { emit } = planDownloadCompletedEmit(EMPTY_UPDATE_ANALYTICS_STATE, '1.2.3');
    expect(emit).toBe(true);
  });

  it('does not re-emit when the hourly poll re-fires the cached download', () => {
    const first = planDownloadCompletedEmit(EMPTY_UPDATE_ANALYTICS_STATE, '1.2.3');
    // Same version, next poll an hour later, straight from cache.
    const second = planDownloadCompletedEmit(first.next, '1.2.3');
    const third = planDownloadCompletedEmit(second.next, '1.2.3');
    expect(second.emit).toBe(false);
    expect(third.emit).toBe(false);
  });

  it('emits again when a newer version supersedes the pending one', () => {
    const first = planDownloadCompletedEmit(EMPTY_UPDATE_ANALYTICS_STATE, '1.2.3');
    const superseded = planDownloadCompletedEmit(first.next, '1.2.4');
    expect(superseded.emit).toBe(true);
  });
});

describe('update_error dedup', () => {
  it('emits the first occurrence of a (stage, type) pair', () => {
    const { emit } = planUpdateErrorEmit(EMPTY_UPDATE_ANALYTICS_STATE, 'check', 'network');
    expect(emit).toBe(true);
  });

  it('does not re-emit the same failure on the next poll', () => {
    const first = planUpdateErrorEmit(EMPTY_UPDATE_ANALYTICS_STATE, 'check', 'network');
    expect(planUpdateErrorEmit(first.next, 'check', 'network').emit).toBe(false);
  });

  it('emits when the failure changes stage or type', () => {
    const first = planUpdateErrorEmit(EMPTY_UPDATE_ANALYTICS_STATE, 'check', 'network');
    expect(planUpdateErrorEmit(first.next, 'download', 'network').emit).toBe(true);
    expect(planUpdateErrorEmit(first.next, 'check', 'disk_space').emit).toBe(true);
  });

  it('stays suppressed across an intervening successful check', () => {
    // This is the actual 182k-events bug. A flapping network produces
    // error -> success -> error -> success..., and the old code cleared the
    // dedup key on each success, so every poll re-emitted.
    let state = planUpdateErrorEmit(EMPTY_UPDATE_ANALYTICS_STATE, 'check', 'network').next;
    for (let poll = 0; poll < 24; poll++) {
      // A successful check must not re-arm the guard.
      const afterError = planUpdateErrorEmit(state, 'check', 'network');
      expect(afterError.emit).toBe(false);
      state = afterError.next;
    }
  });
});
