// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ keys: new Map<string, string>(), windows: [] as any[], partitions: new Map<string, any>(), load: undefined as undefined | ((w: any, url: string) => Promise<void>), execute: undefined as undefined | ((w: any, script: string) => Promise<unknown>) }));
const raw = { creditBalanceText: '$0', planText: 'pro', weekly: { utilizationText: '41% used', resetAt: '2026-10-12T00:00:00Z' } };
// Public vendor application ID from Ollama's anonymous /signin redirect.
const authClient = 'client_01JX0QMHD43PFFCCNXH82A6K8B';
function authorizationURL(change: (url: URL) => void = () => {}) {
  const url = new URL('https://api.workos.com/user_management/authorize');
  url.search = new URLSearchParams({ client_id: authClient, provider: 'authkit', response_type: 'code', redirect_uri: 'https://ollama.com/auth/callback' }).toString();
  change(url); return url.toString();
}
function redirect(window: any, url: string, navigation = 'will-redirect', mainFrame = true) {
  const event = { preventDefault: vi.fn() };
  window.webContents.emit(navigation, event, url, false, mainFrame);
  if (event.preventDefault.mock.calls.length) throw new Error('ERR_FAILED');
  window.url = url; return event;
}
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
    if (!mock.partitions.has(partition)) mock.partitions.set(partition, { clearStorageData: vi.fn(async () => {}), setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }); return mock.partitions.get(partition);
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
  it.each([false, true])('denies permission checks and requests in a visible=%s window', async visible => {
    const pending = visible ? scraper.connect('/permission-guard') : scraper.read('/permission-guard');
    await vi.advanceTimersByTimeAsync(0);
    const window = mock.windows[0];
    const partition = mock.partitions.get(window.options.webPreferences.partition);
    expect(partition.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(partition.setPermissionCheckHandler.mock.calls[0][0](window.webContents, 'media', 'https://signin.ollama.com', { isMainFrame: true })).toBe(false);
    const callback = vi.fn();
    partition.setPermissionRequestHandler.mock.calls[0][0](window.webContents, 'media', callback, {});
    expect(callback).toHaveBeenCalledWith(false);
    window.destroy(); await pending;
  });
  it.each([false, true])('guards direct frame navigation without consuming visible=%s main-frame authorization', async visible => {
    const blocked: any[] = [];
    mock.load = async (w, url) => {
      w.url = url;
      if (visible) redirect(w, 'https://ollama.com/signin');
      for (const url of [authorizationURL(), 'https://evil.test/frame']) {
        const event = { preventDefault: vi.fn(), url, isMainFrame: false, isSameDocument: false, frame: null };
        w.webContents.emit('will-frame-navigate', event); blocked.push(event);
      }
      const allowed = { preventDefault: vi.fn(), url: 'https://ollama.com/settings', isMainFrame: false, isSameDocument: false, frame: null };
      w.webContents.emit('will-frame-navigate', allowed);
      expect(allowed.preventDefault).not.toHaveBeenCalled();
      const subframeRedirect = { preventDefault: vi.fn() };
      w.webContents.emit('will-redirect', subframeRedirect, 'https://ollama.com/signin', false, false);
      expect(subframeRedirect.preventDefault).not.toHaveBeenCalled();
      if (visible) { redirect(w, authorizationURL()); redirect(w, 'https://signin.ollama.com/'); }
    };
    const pending = visible ? scraper.connect('/frame-guard') : scraper.read('/frame-guard');
    await vi.advanceTimersByTimeAsync(0);
    for (const event of blocked) expect(event.preventDefault).toHaveBeenCalledOnce();
    const window = mock.windows[0];
    if (visible) expect(window.destroyed).toBe(false);
    window.destroy();
    expect(await pending).toMatchObject({ status: visible ? 'sign-in-required' : 'ok' });
  });
  it('returns sign-in-required without opening a visible window and backs off failures', async () => {
    mock.load = async w => { w.url = 'https://signin.ollama.com'; }; expect(await scraper.read('/A')).toEqual({ status: 'sign-in-required' }); expect(await scraper.read('/A')).toEqual({ status: 'sign-in-required' }); expect(mock.windows).toHaveLength(1); expect(mock.windows[0].options.show).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000); await scraper.read('/A'); expect(mock.windows).toHaveLength(2);
  });
  it.each([
    ['https://ollama.com/signin', 'sign-in-required', true],
    ['https://evil.test/signin', 'error', true],
    ['https://ollama.com.evil/signin', 'error', true],
  ])('handles the actual settings redirect to %s', async (redirect, status, denied) => {
    const event = { preventDefault: vi.fn() };
    mock.load = async w => {
      w.webContents.emit('will-redirect', event, redirect);
      if (event.preventDefault.mock.calls.length) throw new Error('ERR_FAILED');
      w.url = redirect;
    };
    expect(await scraper.read('/signed-out')).toMatchObject({ status });
    expect(event.preventDefault.mock.calls.length > 0).toBe(denied);
    expect(mock.windows[0].options.show).toBe(false);
    expect(mock.windows[0].webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(mock.windows[0].destroyed).toBe(true);
  });
  it.each([
    ['will-redirect', 'https://ollama.com/signin'],
    ['will-navigate', 'https://ollama.com/signin'],
    ['will-redirect', 'https://signin.ollama.com/email-code'],
    ['will-navigate', 'https://signin.ollama.com/email-code'],
  ])('stops a hidden %s to %s before the next authentication hop', async (navigation, loginUrl) => {
    const login = { preventDefault: vi.fn() }, auth = { preventDefault: vi.fn() };
    const followed: string[] = [];
    mock.load = async w => {
      w.webContents.emit(navigation, login, loginUrl, false, true);
      if (login.preventDefault.mock.calls.length) throw new Error('ERR_FAILED');
      followed.push(loginUrl);
      w.webContents.emit('will-redirect', auth, 'https://api.workos.com/user_management/authorize', false, true);
      if (auth.preventDefault.mock.calls.length) throw new Error('ERR_FAILED');
      w.url = 'https://api.workos.com/user_management/authorize';
    };
    expect(await scraper.read('/signed-out-chain')).toEqual({ status: 'sign-in-required' });
    expect(login.preventDefault).toHaveBeenCalledOnce(); expect(followed).toEqual([]);
    expect(auth.preventDefault).not.toHaveBeenCalled();
    expect(mock.windows[0].webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(mock.windows[0].destroyed).toBe(true);
  });
  it('keeps explicit sign-in navigation user-owned', async () => {
    const event = { preventDefault: vi.fn() };
    mock.load = async w => { w.webContents.emit('will-redirect', event, 'https://ollama.com/signin', false, true); w.url = 'https://ollama.com/signin'; };
    const pending = scraper.connect('/explicit-login'); await vi.advanceTimersByTimeAsync(0);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(mock.windows[0].options.show).toBe(true);
    mock.windows[0].destroy(); expect(await pending).toEqual({ status: 'sign-in-required' });
  });
  it('does not treat a subframe login redirect as a signed-out settings page', async () => {
    const event = { preventDefault: vi.fn() };
    mock.load = async (w, url) => { w.url = url; w.webContents.emit('will-redirect', event, 'https://ollama.com/signin', false, false); };
    expect(await scraper.read('/settings-with-frame')).toMatchObject({ status: 'ok' });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it('deduplicates same-account reads', async () => {
    mock.keys.set('/A', 'shared'); mock.keys.set('/B', 'shared'); const [a, b] = await Promise.all([scraper.read('/A'), scraper.read('/B')]); expect(a).toEqual(b); expect(mock.windows).toHaveLength(1);
  });
  it.each([false, true])('keeps the real public foreground chain user-owned (site state: %s)', async withState => {
    let authorization: ReturnType<typeof redirect> | undefined;
    mock.load = async (w, url) => {
      w.url = url; redirect(w, 'https://ollama.com/signin');
      authorization = redirect(w, authorizationURL(u => { if (withState) u.searchParams.set('state', 'synthetic-opaque-site-state'); }));
      redirect(w, 'https://signin.ollama.com/?authorization_session_id=synthetic');
    };
    const pending = scraper.connect('/foreground-chain'); await vi.advanceTimersByTimeAsync(0);
    const window = mock.windows[0];
    expect(window.destroyed).toBe(false); expect(window.options.show).toBe(true);
    expect(authorization?.preventDefault).not.toHaveBeenCalled();
    expect(window.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(await scraper.read('/foreground-chain')).toEqual({ status: 'sign-in-required' });
    window.destroy(); expect(await pending).toEqual({ status: 'sign-in-required' });
  });
  it.each<[string, (url: URL) => void]>([
    ['lookalike origin', u => { u.hostname = 'api.workos.com.evil'; }],
    ['wrong path', u => { u.pathname = '/user_management/authenticate'; }],
    ['http', u => { u.protocol = 'http:'; }],
    ['userinfo', u => { u.username = 'synthetic'; }],
    ['fragment', u => { u.hash = 'synthetic'; }],
    ['different client', u => { u.searchParams.set('client_id', 'client_synthetic_other'); }],
    ['different provider', u => { u.searchParams.set('provider', 'GoogleOAuth'); }],
    ['off-origin callback', u => { u.searchParams.set('redirect_uri', 'https://evil.test/auth/callback'); }],
    ['callback query', u => { u.searchParams.set('redirect_uri', 'https://ollama.com/auth/callback?next=synthetic'); }],
    ['different response type', u => { u.searchParams.set('response_type', 'token'); }],
    ['additional scope', u => { u.searchParams.set('scope', 'synthetic'); }],
    ['blank unknown key', u => { u.searchParams.set('unexpected', ''); }],
    ['duplicate client', u => { u.searchParams.append('client_id', authClient); }],
    ['duplicate state', u => { u.searchParams.append('state', 'one'); u.searchParams.append('state', 'two'); }],
    ['empty state', u => { u.searchParams.set('state', ''); }],
  ])('rejects a foreground authorization with %s', async (_name, change) => {
    mock.load = async (w, url) => { w.url = url; redirect(w, 'https://ollama.com/signin'); redirect(w, authorizationURL(change)); };
    expect(await scraper.connect('/rejected-authorization')).toMatchObject({ status: 'error' });
    expect(mock.windows[0].destroyed).toBe(true);
    expect(mock.windows[0].webContents.executeJavaScript).not.toHaveBeenCalled();
  });
  it.each([
    ['no signin redirect', 'none', true, 'will-redirect'],
    ['direct signin navigation', 'will-navigate', true, 'will-redirect'],
    ['subframe signin', 'will-redirect', false, 'will-redirect'],
    ['direct WorkOS navigation', 'will-redirect', true, 'will-navigate'],
    ['subframe WorkOS', 'will-redirect', true, 'subframe'],
  ])('rejects authorization after %s', async (_name, signinNavigation, signinMainFrame, authNavigation) => {
    mock.load = async (w, url) => {
      w.url = url;
      if (signinNavigation !== 'none') redirect(w, 'https://ollama.com/signin', signinNavigation, signinMainFrame);
      redirect(w, authorizationURL(), authNavigation === 'subframe' ? 'will-redirect' : authNavigation, authNavigation !== 'subframe');
    };
    expect(await scraper.connect('/unarmed-authorization')).toMatchObject({ status: 'error' });
    expect(mock.windows[0].destroyed).toBe(true);
  });
  it('keeps foreground authorization eligibility window-local and consumes it once', async () => {
    mock.load = async (w, url) => {
      w.url = url;
      if (mock.windows.length === 1) redirect(w, 'https://ollama.com/signin');
      else redirect(w, authorizationURL());
    };
    const first = scraper.connect('/first-authorization');
    expect(await scraper.connect('/other-authorization')).toMatchObject({ status: 'error' });
    const window = mock.windows[0]; expect(window.destroyed).toBe(false);
    redirect(window, authorizationURL());
    const secondHop = { preventDefault: vi.fn() };
    window.webContents.emit('will-redirect', secondHop, authorizationURL(), false, true);
    expect(secondHop.preventDefault).toHaveBeenCalledOnce();
    window.destroy(); expect(await first).toEqual({ status: 'sign-in-required' });
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
