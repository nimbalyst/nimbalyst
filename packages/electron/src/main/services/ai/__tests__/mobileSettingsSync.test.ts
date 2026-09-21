// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

const { syncSettingsToMobile, warn } = vi.hoisted(() => ({ syncSettingsToMobile: vi.fn(), warn: vi.fn() }));
vi.mock('../../SyncManager', () => ({ syncSettingsToMobile }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { warn } } }));
import { scheduleMobileSettingsSync } from '../mobileSettingsSync';

afterEach(() => { vi.useRealTimers(); });

it('coalesces settings changes and warns when the asynchronous sync rejects', async () => {
  vi.useFakeTimers();
  const error = new Error('settings disconnected');
  const rejection = Promise.reject(error);
  void rejection.catch(() => {});
  syncSettingsToMobile.mockReturnValue(rejection);
  scheduleMobileSettingsSync();
  scheduleMobileSettingsSync();
  await vi.advanceTimersByTimeAsync(500);
  await vi.dynamicImportSettled();
  expect(syncSettingsToMobile).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('settings'), error);
});
