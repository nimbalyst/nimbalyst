// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ keys: new Map<string, string>(), windows: [] as any[], partitions: new Map<string, any>(), load: undefined as undefined | ((w: any, url: string) => Promise<void>), execute: undefined as undefined | ((w: any, script: string) => Promise<unknown>) }));
const raw = { creditBalanceText: '$0', planText: 'pro', weekly: { utilizationText: '41% used', resetAt: '2026-10-12T00:00:00Z' } };
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWindow extends EventEmitter {
    destroyed = false; url = ''; focus = vi.fn(); webContents: any;
    constructor(public options: any) {
      super(); this.webContents = Object.assign(new EventEmitter(), { getURL: () => this.url, setWindowOpenHandler: vi.fn(), executeJavaScript: vi.fn((script: string) => mock.execute!(this, script)) }); mock.windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); } }
    loadURL(url: string) { return mock.load!(this, url); }
  }
  return { BrowserWindow: FakeWindow, session: { fromPartition: (partition: string) => {
    if (!mock.partitions.has(partition)) mock.partitions.set(partition, { clearStorageData: vi.fn(async () => {}), setPermissionRequestHandler: vi.fn() }); return mock.partitions.get(partition);
  } } };
});
vi.mock('../../utils/store', () => ({ getProviderApiKeyFromSettings: (_p: string, workspace: string) => mock.keys.get(workspace) }));
import { getOllamaDashboardBinding, isOllamaLoginNavigation, isOllamaUsagePage, ollamaDashboardScraper as scraper, ollamaUsagePartition } from '../OllamaDashboardScraper';
describe('private Ollama dashboard reader', () => {
  beforeEach(() => { scraper.stop(); vi.useFakeTimers(); mock.windows.length = 0; mock.keys.clear(); mock.partitions.clear(); mock.load = async (w, url) => { w.url = url; queueMicrotask(() => w.webContents.emit('did-finish-load')); }; mock.execute = async () => raw; });
  afterEach(() => { scraper.stop(); vi.useRealTimers(); });
  it('isolates persistent partitions by key without exposing it', () => {
    mock.keys.set('/A', 'synthetic-one'); mock.keys.set('/B', 'synthetic-one'); mock.keys.set('/C', 'synthetic-two'); const binding = getOllamaDashboardBinding('/A');
    expect(binding).toMatch(/^[a-f0-9]{64}$/); expect(getOllamaDashboardBinding('/B')).toBe(binding); expect(getOllamaDashboardBinding('/C')).not.toBe(binding);
    expect(ollamaUsagePartition(binding)).toBe(`persist:ollama-usage-v1-${binding}`); expect(() => ollamaUsagePartition('synthetic-one')).toThrow(); expect(() => getOllamaDashboardBinding('')).toThrow('active workspace');
    expect(getOllamaDashboardBinding('/unconfigured-A')).not.toBe(getOllamaDashboardBinding('/unconfigured-B'));
  });
  it('preserves distinct case-sensitive workspace identities without a configured key', () => {
    const platform = process.platform;
    try {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect(getOllamaDashboardBinding('/workspace/A')).not.toBe(getOllamaDashboardBinding('/workspace/a'));
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });
  it('rejects lookalike origins and restricts extraction to the clean settings URL', () => {
    expect(isOllamaUsagePage('https://ollama.com/settings')).toBe(true);
    for (const url of ['http://ollama.com/settings', 'https://ollama.com.evil/settings', 'https://ollama.com/settings?token=synthetic', 'https://ollama.com/settings#account', 'https://u:p@ollama.com/settings']) expect(isOllamaUsagePage(url)).toBe(false);
    expect(isOllamaLoginNavigation('https://signin.ollama.com/email-code')).toBe(true); expect(isOllamaLoginNavigation('https://ollama.com/auth/callback?code=synthetic')).toBe(true);
    for (const url of ['https://evil.test', 'https://ollama.com/admin', 'https://u:p@signin.ollama.com', 'http://signin.ollama.com']) expect(isOllamaLoginNavigation(url)).toBe(false);
  });
  it('uses a hidden sandboxed window, denies permissions and popups, then destroys it', async () => {
    expect(await scraper.read('/A')).toMatchObject({ status: 'ok', snapshot: { creditBalanceUSD: 0, weekly: { utilization: 41 } } }); const w = mock.windows[0];
    expect(w.options).toMatchObject({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } }); expect(w.options.webPreferences).not.toHaveProperty('preload');
    expect(w.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' }); const callback = vi.fn(); [...mock.partitions.values()][0].setPermissionRequestHandler.mock.calls[0][0]({}, 'clipboard-read', callback); expect(callback).toHaveBeenCalledWith(false);
    const event = { preventDefault: vi.fn() }; w.webContents.emit('will-redirect', event, 'https://evil.test'); expect(event.preventDefault).toHaveBeenCalledOnce();
    const script = w.webContents.executeJavaScript.mock.calls[0][0]; expect(script).toContain("location.origin !== 'https://ollama.com'"); expect(script).toContain("location.pathname !== '/settings'"); expect(script).not.toMatch(/document\.cookie|localStorage|sessionStorage/); expect(w.destroyed).toBe(true);
  });
  it('returns sign-in-required without opening a visible window and backs off failures', async () => {
    mock.load = async w => { w.url = 'https://signin.ollama.com'; }; expect(await scraper.read('/A')).toEqual({ status: 'sign-in-required' }); expect(await scraper.read('/A')).toEqual({ status: 'sign-in-required' }); expect(mock.windows).toHaveLength(1); expect(mock.windows[0].options.show).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000); await scraper.read('/A'); expect(mock.windows).toHaveLength(2);
  });
  it('recognizes the observed same-origin sign-in redirect without reading account data', async () => {
    mock.load = async w => {
      const redirect = 'https://ollama.com/signin';
      const event = { preventDefault: vi.fn() };
      w.webContents.emit('will-redirect', event, redirect);
      if (event.preventDefault.mock.calls.length) throw new Error('ERR_ABORTED');
      w.url = redirect;
      w.webContents.emit('did-finish-load');
    };
    expect(await scraper.read('/A')).toEqual({ status: 'sign-in-required' });
    expect(mock.windows[0].options.show).toBe(false);
    expect(mock.windows[0].webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(mock.windows[0].destroyed).toBe(true);
    expect(isOllamaLoginNavigation('https://ollama.com.evil/signin')).toBe(false);
    expect(isOllamaLoginNavigation('http://ollama.com/signin')).toBe(false);
    expect(isOllamaLoginNavigation('https://u:p@ollama.com/signin')).toBe(false);
  });
  it('deduplicates same-account reads', async () => {
    mock.keys.set('/A', 'shared'); mock.keys.set('/B', 'shared'); const [a, b] = await Promise.all([scraper.read('/A'), scraper.read('/B')]); expect(a).toEqual(b); expect(mock.windows).toHaveLength(1);
  });
  it('discards results after a configured key change', async () => {
    mock.keys.set('/A', 'first'); mock.execute = async () => { mock.keys.set('/A', 'second'); return raw; }; expect(await scraper.read('/A')).toEqual({ status: 'sign-in-required' });
  });
  it('rechecks the page and never echoes raw browser errors', async () => {
    mock.execute = async w => { w.url = 'https://evil.test'; return raw; }; expect(await scraper.read('/A')).toEqual({ status: 'error', error: 'Ollama dashboard usage could not be read.' });
    mock.execute = async () => { throw new Error('synthetic sensitive browser detail'); }; expect(await scraper.read('/B')).toEqual({ status: 'error', error: 'Ollama dashboard usage could not be read.' });
  });
  it.each(['load', 'execute'])('bounds a hung %s to ten seconds', async phase => {
    if (phase === 'load') mock.load = () => new Promise(() => {}); else mock.execute = () => new Promise(() => {}); const pending = scraper.read('/A'); await vi.advanceTimersByTimeAsync(10_000); expect(await pending).toMatchObject({ status: 'error' }); expect(mock.windows[0].destroyed).toBe(true);
  });
  it('opens one explicit login and returns cancellation honestly', async () => {
    mock.load = async w => { w.url = 'https://signin.ollama.com'; }; const first = scraper.connect('/A'); const second = scraper.connect('/A'); expect(first).toBe(second); expect(mock.windows).toHaveLength(1); expect(mock.windows[0].options.show).toBe(true); expect(mock.windows[0].focus).toHaveBeenCalledOnce(); expect(await scraper.read('/A')).toEqual({ status: 'sign-in-required' }); mock.windows[0].destroy(); expect(await first).toEqual({ status: 'sign-in-required' });
  });
  it('completes a settings snapshot and bounds abandoned login', async () => {
    expect(await scraper.connect('/A')).toMatchObject({ status: 'ok' }); expect(mock.windows[0].destroyed).toBe(true); mock.load = async w => { w.url = 'https://signin.ollama.com'; }; const pending = scraper.connect('/B'); await vi.advanceTimersByTimeAsync(10 * 60_000); expect(await pending).toEqual({ status: 'sign-in-required' }); expect(mock.windows[1].destroyed).toBe(true);
  });
  it('blocks new work while forgetting and discards the old in-flight snapshot', async () => {
    let release!: (value: unknown) => void; mock.execute = () => new Promise(resolve => { release = resolve; }); const read = scraper.read('/A'); await vi.advanceTimersByTimeAsync(0); const forget = scraper.forget('/A'); expect(await scraper.read('/A')).toEqual({ status: 'sign-in-required' }); expect(await scraper.connect('/A')).toEqual({ status: 'sign-in-required' }); expect(mock.windows).toHaveLength(1); release(raw); expect(await read).toEqual({ status: 'sign-in-required' }); await forget;
    expect(mock.partitions.size).toBe(1); expect(mock.partitions.get(ollamaUsagePartition(getOllamaDashboardBinding('/A'))).clearStorageData).toHaveBeenCalledOnce(); expect(await scraper.read('/A')).toEqual({ status: 'sign-in-required' }); mock.execute = async () => raw; expect(await scraper.connect('/A')).toMatchObject({ status: 'ok' });
  });
  it('stays disconnected after failed storage clear until explicit reconnect', async () => {
    await scraper.read('/A'); [...mock.partitions.values()][0].clearStorageData.mockRejectedValueOnce(new Error('synthetic storage failure')); await expect(scraper.forget('/A')).rejects.toThrow('storage failure'); expect(await scraper.read('/A')).toEqual({ status: 'sign-in-required' }); expect(mock.windows).toHaveLength(1); expect(await scraper.connect('/A')).toMatchObject({ status: 'ok' });
  });
});
