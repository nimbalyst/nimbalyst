// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/test-user-data' }, BrowserWindow: {} }));
vi.mock('../ipcRegistry', () => ({ safeOn: vi.fn() }));
vi.mock('../cpuProfileRetention', () => ({ pruneCpuProfiles: vi.fn() }));

import { pruneCpuProfiles } from '../cpuProfileRetention';
import { startPerformanceMonitoring, stopPerformanceMonitoring } from '../performanceMonitor';

afterEach(() => {
  stopPerformanceMonitoring();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('prunes at startup and periodically, coalesces slow passes, and stops scheduling on shutdown', async () => {
  vi.useFakeTimers();
  vi.spyOn(process, 'cpuUsage').mockReturnValue({ user: 0, system: 0 });
  let finish!: (value: { deletedCount: number; deletedBytes: number }) => void;
  vi.mocked(pruneCpuProfiles).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ deletedCount: 0, deletedBytes: 0 });
  startPerformanceMonitoring();
  expect(pruneCpuProfiles).toHaveBeenCalledWith('/test-user-data/logs');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(pruneCpuProfiles).toHaveBeenCalledTimes(1);
  finish({ deletedCount: 0, deletedBytes: 0 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(pruneCpuProfiles).toHaveBeenCalledTimes(2);
  stopPerformanceMonitoring();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(pruneCpuProfiles).toHaveBeenCalledTimes(2);
  startPerformanceMonitoring();
  expect(pruneCpuProfiles).toHaveBeenCalledTimes(3);
});

it('reports a cleanup failure and retries on the next maintenance interval', async () => {
  vi.useFakeTimers();
  vi.spyOn(process, 'cpuUsage').mockReturnValue({ user: 0, system: 0 });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = new Error('permission denied');
  vi.mocked(pruneCpuProfiles).mockRejectedValueOnce(error).mockResolvedValue({ deletedCount: 0, deletedBytes: 0 });
  startPerformanceMonitoring();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(warning).toHaveBeenCalledWith('[PERF] CPU profile retention failed:', error);
  expect(pruneCpuProfiles).toHaveBeenCalledTimes(2);
});
