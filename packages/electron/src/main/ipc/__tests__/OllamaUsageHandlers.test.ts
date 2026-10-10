// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), getUsage: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), getResetUsage: vi.fn(), recordActivity: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => ({ id: 1 }) } }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (channel: string, handler: (...args: any[]) => any) => mock.handlers.set(channel, handler) }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), error: vi.fn() } } }));
vi.mock('../../window/windowState', () => ({ windowStates: new Map([[1, { workspacePath: '/A' }]]), getWindowIdForWindow: (w: { id: number }) => w.id, windowReferencesWorkspace: (state: { workspacePath: string } | undefined, path: string) => state?.workspacePath === path }));
vi.mock('../../services/OllamaUsageService', () => ({ ollamaUsageService: mock }));
import { registerOllamaUsageHandlers } from '../OllamaUsageHandlers';
const event = { sender: {} };
describe('Ollama dashboard IPC workspace boundary', () => {
  beforeEach(() => { vi.clearAllMocks(); mock.handlers.clear(); mock.getUsage.mockResolvedValue({ creditBalanceUSD: 0 }); registerOllamaUsageHandlers(); });
  it('serves the open workspace and rejects unrelated projects', async () => {
    expect(await mock.handlers.get('ollama-usage:get')!(event, '/A')).toEqual({ creditBalanceUSD: 0 }); expect(await mock.handlers.get('ollama-usage:get')!(event, '/B')).toBeNull(); await expect(mock.handlers.get('ollama-usage:refresh')!(event, '/B')).rejects.toThrow('could not be refreshed'); expect(mock.getUsage).toHaveBeenCalledOnce(); for (const channel of ['ollama-usage:connect', 'ollama-usage:disconnect', 'ollama-usage:reset-times']) await expect(mock.handlers.get(channel)!(event, '/B')).rejects.toThrow('not open'); expect(mock.connect).not.toHaveBeenCalled(); expect(mock.disconnect).not.toHaveBeenCalled();
  });
  it('registers explicit connect/forget and retires pasted-cookie routes', async () => {
    for (const channel of ['ollama:get-cookie-status', 'ollama:set-cookie', 'ollama:clear-cookie']) expect(mock.handlers.has(channel)).toBe(false); await mock.handlers.get('ollama-usage:connect')!(event, '/A'); expect(mock.connect).toHaveBeenCalledWith('/A', { id: 1 }); await mock.handlers.get('ollama-usage:disconnect')!(event, '/A'); expect(mock.disconnect).toHaveBeenCalledWith('/A');
  });
  it('uses the same service for refresh and reset compatibility', async () => {
    await mock.handlers.get('ollama-usage:refresh')!(event, '/A'); expect(mock.getUsage).toHaveBeenCalledWith('/A', true); await mock.handlers.get('ollama-usage:reset-times')!(event, '/A'); expect(mock.getResetUsage).toHaveBeenCalledWith('/A');
  });
  it('does not echo raw browser failures', async () => {
    mock.getUsage.mockRejectedValueOnce(new Error('synthetic sensitive detail')); await expect(mock.handlers.get('ollama-usage:refresh')!(event, '/A')).rejects.toThrow(/^Ollama usage could not be refreshed\.$/);
  });
  it.each([['connect', 'connect'], ['disconnect', 'disconnect'], ['reset-times', 'getResetUsage']])('sanitizes %s failures', async (channel, method) => {
    mock[method as 'connect' | 'disconnect' | 'getResetUsage'].mockRejectedValueOnce(new Error('synthetic sensitive detail'));
    try { await mock.handlers.get(`ollama-usage:${channel}`)!(event, '/A'); throw new Error('Expected rejection'); }
    catch (error) { expect(String(error)).toContain('Ollama usage'); expect(String(error)).not.toContain('synthetic'); }
  });
});
