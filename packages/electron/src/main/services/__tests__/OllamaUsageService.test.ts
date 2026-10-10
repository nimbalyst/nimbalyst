// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ bindings: new Map<string, string>(), read: vi.fn(), connect: vi.fn(), forget: vi.fn(), stop: vi.fn(), windows: [1, 2, 3].map(id => ({ id, isDestroyed: () => false, webContents: { send: vi.fn() } })) }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => mock.windows } }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), error: vi.fn() } } }));
vi.mock('../../window/windowState', () => ({ getWindowIdForWindow: (w: { id: number }) => w.id, resolveActiveWorkspacePathForWindowId: (id: number) => id === 1 ? '/A' : id === 2 ? '/B' : null }));
vi.mock('../OllamaDashboardScraper', () => ({ getOllamaDashboardBinding: (p: string) => { if (!p) throw new Error('active workspace'); return mock.bindings.get(p) ?? p; }, ollamaDashboardScraper: { read: mock.read, connect: mock.connect, forget: mock.forget, stop: mock.stop } }));
import { ollamaUsageService as service } from '../OllamaUsageService';
const connected = () => ({ status: 'ok', snapshot: { creditBalanceUSD: 0, plan: 'pro', modelCountsPeriod: 'this-week', weekly: { utilization: 41, resetsAt: '2026-10-12T00:00:00Z', modelCountsAvailable: true, models: [{ name: 'deepseek-v4.1-flash', requestCount: 3656 }] }, session: { utilization: 0, resetsAt: '2026-10-10T01:00:00Z', models: [] } } });
describe('one dashboard usage source', () => {
  beforeEach(() => { service.stop(); vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-09T20:00:00Z')); mock.bindings.clear(); mock.read.mockResolvedValue(connected()); mock.connect.mockResolvedValue(connected()); mock.forget.mockResolvedValue(undefined); });
  afterEach(() => { service.stop(); vi.useRealTimers(); });
  it('reports actual credits, zero usage and model calls without fabricated cost or quotas', async () => {
    const data = await service.getUsage('/A'); expect(data).toMatchObject({ source: 'ollama-dashboard', authStatus: 'connected', limitsAvailable: true, creditBalanceUSD: 0, plan: 'pro', session: { utilization: 0 }, weekly: { models: [{ name: 'deepseek-v4.1-flash', requestCount: 3656 }] }, modelCountsPeriod: 'this-week' }); expect(data.costUSD).toBeUndefined(); expect(data.requestUsage).toBeUndefined(); expect(data.weekly?.windowStart).toBeUndefined();
  });
  it('caches, deduplicates and broadcasts only to windows showing the workspace', async () => {
    const [a, b] = await Promise.all([service.getUsage('/A'), service.getUsage('/A', true)]); expect(a).toEqual(b); expect(mock.read).toHaveBeenCalledOnce(); await service.getUsage('/A'); expect(mock.read).toHaveBeenCalledOnce(); expect(mock.windows[0].webContents.send).toHaveBeenCalledWith('ollama-usage:update', { workspacePath: '/A', usage: a }); expect(mock.windows[1].webContents.send).not.toHaveBeenCalled(); expect(mock.windows[2].webContents.send).not.toHaveBeenCalled(); await service.getUsage('/A', true); expect(mock.read).toHaveBeenCalledTimes(2);
  });
  it('isolates workspace cache and invalidates it when the key changes', async () => {
    await service.getUsage('/A'); await service.getUsage('/B'); mock.bindings.set('/A', 'new'); expect(service.getCachedUsage('/A')).toBeNull(); expect(service.getCachedUsage('/B')).toMatchObject({ creditBalanceUSD: 0 }); await service.getUsage('/A'); expect(mock.read).toHaveBeenCalledTimes(3);
  });
  it.each(['refresh', 'connect'])('invalidates old cached metrics when the key changes during %s', async method => {
    await service.getUsage('/A'); mock.windows[0].webContents.send.mockClear();
    let release!: (value: unknown) => void;
    mock[method === 'refresh' ? 'read' : 'connect'].mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = method === 'refresh' ? service.getUsage('/A', true) : service.connect('/A');
    // Connect immediately publishes the cleared state, before the key changes.
    if (method === 'connect') {
      expect(service.getCachedUsage('/A')).toMatchObject({ authStatus: 'sign-in-required' });
      mock.windows[0].webContents.send.mockClear();
    }
    mock.bindings.set('/A', 'changed'); release(connected());
    const result = await pending; expect(result).toMatchObject({ authStatus: 'sign-in-required' }); expect(result.creditBalanceUSD).toBeUndefined(); expect(result.weekly).toBeUndefined();
    expect(service.getCachedUsage('/A')).toBeNull(); expect(mock.windows[0].webContents.send).not.toHaveBeenCalled();
  });
  it('removes old credits and models on authentication or read failure', async () => {
    await service.getUsage('/A'); mock.read.mockResolvedValueOnce({ status: 'sign-in-required' }); const signedOut = await service.getUsage('/A', true); expect(signedOut).toMatchObject({ authStatus: 'sign-in-required', limitsAvailable: false }); expect(signedOut.creditBalanceUSD).toBeUndefined(); expect(signedOut.weekly).toBeUndefined(); mock.read.mockRejectedValueOnce(new Error('synthetic private detail')); const failure = await service.getUsage('/A', true); expect(failure.authStatus).toBe('error'); expect(JSON.stringify(failure)).not.toContain('synthetic');
  });
  it('preserves a wallet when allowance windows are unavailable', async () => {
    mock.read.mockResolvedValueOnce({ status: 'ok', snapshot: { creditBalanceUSD: 12.5 } }); expect(await service.getUsage('/A')).toMatchObject({ authStatus: 'connected', creditBalanceUSD: 12.5, limitsAvailable: false, limitsUnavailableReason: expect.stringContaining('not shown') });
  });
  it('reports cancellation honestly', async () => {
    mock.connect.mockResolvedValueOnce({ status: 'sign-in-required' }); expect(await service.connect('/A')).toMatchObject({ authStatus: 'sign-in-required', limitsAvailable: false });
  });
  it('prevents an older refresh from overwriting a newly connected snapshot', async () => {
    let release!: (value: unknown) => void; mock.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); const old = service.getUsage('/A'); const fresh = await service.connect('/A'); release({ status: 'sign-in-required' }); expect(await old).toEqual(fresh); expect(service.getCachedUsage('/A')).toEqual(fresh);
  });
  it.each([false, true])('clears prior metrics while reconnect is pending (shared binding: %s)', async shared => {
    if (shared) { mock.bindings.set('/A', 'same'); mock.bindings.set('/B', 'same'); }
    const previous = await service.getUsage('/A');
    const other = await service.getUsage('/B');
    for (const window of mock.windows) window.webContents.send.mockClear();
    let releaseRead!: (value: unknown) => void;
    let releaseConnect!: (value: unknown) => void;
    let releaseOther!: (value: unknown) => void;
    mock.read.mockImplementationOnce(() => new Promise(resolve => { releaseRead = resolve; }));
    mock.connect.mockImplementationOnce(() => new Promise(resolve => { releaseConnect = resolve; }));
    const old = service.getUsage('/A', true);
    if (shared) mock.read.mockImplementationOnce(() => new Promise(resolve => { releaseOther = resolve; }));
    const otherPending = shared ? service.getUsage('/B', true) : null;
    const login = service.connect('/A');
    releaseRead(connected());
    const stale = await old;
    if (shared) releaseOther(connected());
    const cleared = service.getCachedUsage('/A');
    expect(stale).toEqual(cleared);
    expect(cleared).toMatchObject({ authStatus: 'sign-in-required', limitsAvailable: false });
    for (const key of ['plan', 'creditBalanceUSD', 'session', 'weekly', 'modelCountsPeriod']) {
      expect(previous).toHaveProperty(key);
      expect(stale).not.toHaveProperty(key);
    }
    expect(mock.windows[0].webContents.send).toHaveBeenCalledExactlyOnceWith('ollama-usage:update', { workspacePath: '/A', usage: cleared });
    expect(service.getCachedUsage('/B')).toEqual(shared ? cleared : other);
    if (otherPending) expect(await otherPending).toEqual(cleared);
    if (shared) expect(mock.windows[1].webContents.send).toHaveBeenCalledExactlyOnceWith('ollama-usage:update', { workspacePath: '/B', usage: cleared });
    else expect(mock.windows[1].webContents.send).not.toHaveBeenCalled();
    releaseConnect({ status: 'ok', snapshot: { creditBalanceUSD: 17, plan: 'new-account' } });
    expect(await login).toMatchObject({ plan: 'new-account', creditBalanceUSD: 17 });
  });
  it('disconnects shared-key workspaces and invalidates pending reads', async () => {
    mock.bindings.set('/A', 'same'); mock.bindings.set('/B', 'same'); await service.getUsage('/B'); let release!: (value: unknown) => void; mock.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); const pending = service.getUsage('/A'); await service.disconnect('/A'); release(connected()); expect(await pending).toMatchObject({ authStatus: 'sign-in-required' }); expect(service.getCachedUsage('/A')).toMatchObject({ authStatus: 'sign-in-required' }); expect(service.getCachedUsage('/B')).toMatchObject({ authStatus: 'sign-in-required' }); expect(mock.forget).toHaveBeenCalledWith('/A');
  });
  it('polls at five minutes and stops after idle', async () => {
    await service.getUsage('/A'); await vi.advanceTimersByTimeAsync(5 * 60_000); expect(mock.read).toHaveBeenCalledTimes(2); await vi.advanceTimersByTimeAsync(60 * 60_000); const count = mock.read.mock.calls.length; await vi.advanceTimersByTimeAsync(15 * 60_000); expect(mock.read).toHaveBeenCalledTimes(count);
  });
  it('does not publish work that finishes after stop', async () => {
    await service.getUsage('/A'); mock.windows[0].webContents.send.mockClear();
    let release!: (value: unknown) => void; mock.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); const pending = service.getUsage('/A', true); service.stop(); release(connected()); const result = await pending; expect(result).toMatchObject({ authStatus: 'sign-in-required' }); expect(result.creditBalanceUSD).toBeUndefined(); expect(result.weekly).toBeUndefined(); expect(mock.windows[0].webContents.send).not.toHaveBeenCalled();
  });
});
