// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ read: vi.fn(async () => ({ status: 'ok', snapshot: { creditBalanceUSD: 0, weekly: { utilization: 41, resetsAt: '2026-10-12T00:00:00Z', models: [] } } })), oldScrape: vi.fn(), oldCookie: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn() } } }));
vi.mock('../../window/windowState', () => ({ getWindowIdForWindow: vi.fn(), resolveActiveWorkspacePathForWindowId: vi.fn() }));
vi.mock('../OllamaDashboardScraper', () => ({ getOllamaDashboardBinding: (path: string) => path, ollamaDashboardScraper: { read: mock.read, stop: vi.fn() } }));
vi.mock('../OllamaResetTimeScraper', () => ({ scrapeOllamaResetTimes: mock.oldScrape }));
vi.mock('../OllamaCookieService', () => ({ getOllamaCookie: mock.oldCookie }));
import { ollamaUsageService as service } from '../OllamaUsageService';
afterEach(() => service.stop());
it('routes reset compatibility through the complete reader without cookie scraping', async () => {
  const usage = await service.getUsage('/A'); const reset = await service.getResetUsage('/A'); expect(reset).toEqual(usage); expect(reset).toMatchObject({ creditBalanceUSD: 0, weekly: { resetsAt: '2026-10-12T00:00:00Z' } }); expect(mock.read).toHaveBeenCalledOnce(); expect(mock.oldScrape).not.toHaveBeenCalled(); expect(mock.oldCookie).not.toHaveBeenCalled();
});