/** One private browser-session reader; credentials never leave Chromium. */
import { BrowserWindow, session } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getProviderApiKeyFromSettings } from '../utils/store';
import { OLLAMA_DASHBOARD_DOM_SCRIPT, parseOllamaDashboardUsage, type OllamaDashboardResult } from '../../shared/ollamaDashboardUsage';

const SETTINGS_URL = 'https://ollama.com/settings';
const READ_TIMEOUT_MS = 10_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const FAILURE_RETRY_MS = 30_000;
// Public Ollama AuthKit application, pinned from its anonymous /signin redirect.
const OLLAMA_AUTHKIT_CLIENT_SHA256 = 'a3d61c078ac261b3f6853748823e3d4ce3f9374ae7cf727d586cff339cc58025';

export function getOllamaDashboardBinding(workspacePath: string): string {
  if (!workspacePath?.trim()) throw new Error('Ollama usage requires an active workspace');
  const apiKey = getProviderApiKeyFromSettings('ollama', workspacePath);
  // Workspaces using the same configured key share one user-owned dashboard login.
  // This is isolation, not proof that the browser account owns that API key.
  const resolvedWorkspace = path.resolve(workspacePath);
  const subject = apiKey || (process.platform === 'win32' ? resolvedWorkspace.toLowerCase() : resolvedWorkspace);
  return createHash('sha256').update('ollama-dashboard-v1\0').update(subject).digest('hex');
}

export function ollamaUsagePartition(binding: string): string {
  if (!/^[a-f0-9]{64}$/.test(binding)) throw new Error('Invalid Ollama dashboard binding');
  return `persist:ollama-usage-v1-${binding}`;
}

export function isOllamaUsagePage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://ollama.com' && parsed.pathname === '/settings'
      && !parsed.search && !parsed.hash && !parsed.username && !parsed.password;
  } catch { return false; }
}

export function isOllamaLoginNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.protocol !== 'https:') return false;
    if (parsed.origin === 'https://signin.ollama.com') return true;
    return parsed.origin === 'https://ollama.com'
      && ['/settings', '/signin', '/dashboard', '/auth/callback'].includes(parsed.pathname);
  } catch { return false; }
}

const readError = (): OllamaDashboardResult => ({ status: 'error', error: 'Ollama dashboard usage could not be read.' });

function isOllamaAuthorizationNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.workos.com' || parsed.pathname !== '/user_management/authorize'
      || parsed.username || parsed.password || parsed.hash) return false;
    const params = parsed.searchParams;
    const keys = [...params.keys()];
    if (new Set(keys).size !== keys.length
      || keys.some(key => !['client_id', 'provider', 'redirect_uri', 'response_type', 'state'].includes(key))) return false;
    if (params.has('state') && !params.get('state')) return false;
    return params.get('provider') === 'authkit' && params.get('response_type') === 'code'
      && params.get('redirect_uri') === 'https://ollama.com/auth/callback'
      && createHash('sha256').update(params.get('client_id') || '').digest('hex') === OLLAMA_AUTHKIT_CLIENT_SHA256;
  } catch { return false; }
}

class OllamaDashboardScraperImpl {
  private readonly windows = new Set<BrowserWindow>();
  private readonly reads = new Map<string, Promise<OllamaDashboardResult>>();
  private readonly logins = new Map<string, { promise: Promise<OllamaDashboardResult>; cancel: () => void; window: BrowserWindow }>();
  private readonly failures = new Map<string, { at: number; result: OllamaDashboardResult }>();
  private readonly forgotten = new Set<string>();
  private readonly forgetting = new Map<string, Promise<void>>();

  private createWindow(binding: string, visible: boolean, parent?: BrowserWindow): BrowserWindow {
    const partition = ollamaUsagePartition(binding);
    const browserSession = session.fromPartition(partition);
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const window = new BrowserWindow({
      show: visible, width: 1050, height: 800, title: 'Ollama usage sign-in',
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    this.windows.add(window);
    window.on('closed', () => this.windows.delete(window));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    let nextRedirect: 'signin' | 'workos' | 'done' = visible ? 'signin' : 'done';
    const restrict = (event: { preventDefault(): void }, url: string, httpRedirect: boolean, mainFrame?: boolean) => {
      if (mainFrame === false) {
        if (!isOllamaLoginNavigation(url)) event.preventDefault();
        return;
      }
      const expected = nextRedirect;
      nextRedirect = 'done';
      if (visible && httpRedirect && mainFrame === true && expected === 'workos'
        && isOllamaAuthorizationNavigation(url)) return;
      if (!isOllamaLoginNavigation(url)) { event.preventDefault(); return; }
      if (visible && httpRedirect && mainFrame === true && expected === 'signin'
        && url === 'https://ollama.com/signin') nextRedirect = 'workos';
    };
    window.webContents.on('will-frame-navigate', event => {
      // Subframes cannot authorize or alter the foreground main-frame redirect.
      if (!event.isMainFrame && !isOllamaLoginNavigation(event.url)) event.preventDefault();
    });
    window.webContents.on('will-navigate', (event, url, _inPlace, mainFrame) => restrict(event, url, false, mainFrame));
    window.webContents.on('will-redirect', (event, url, _inPlace, mainFrame) => restrict(event, url, true, mainFrame));
    return window;
  }

  private async extract(window: BrowserWindow): Promise<OllamaDashboardResult> {
    if (window.isDestroyed() || !isOllamaUsagePage(window.webContents.getURL())) return { status: 'sign-in-required' };
    // Fixed script, fixed origin and path. No caller-supplied script or URL.
    const raw: unknown = await window.webContents.executeJavaScript(`(() => {
      if (location.origin !== 'https://ollama.com' || location.pathname !== '/settings' || location.search || location.hash) return null;
      return ${OLLAMA_DASHBOARD_DOM_SCRIPT};
    })()`);
    if (window.isDestroyed() || !isOllamaUsagePage(window.webContents.getURL())) return readError();
    const snapshot = parseOllamaDashboardUsage(raw);
    return snapshot ? { status: 'ok', snapshot } : readError();
  }

  async read(workspacePath: string): Promise<OllamaDashboardResult> {
    const binding = getOllamaDashboardBinding(workspacePath);
    if (this.logins.has(binding) || this.forgotten.has(binding) || this.forgetting.has(binding)) return { status: 'sign-in-required' };
    const pending = this.reads.get(binding);
    if (pending) return pending;
    const failure = this.failures.get(binding);
    if (failure && Date.now() - failure.at < FAILURE_RETRY_MS) return failure.result;
    const operation = this.readOnce(workspacePath, binding);
    this.reads.set(binding, operation);
    try {
      const result = await operation;
      if (this.forgotten.has(binding)) return { status: 'sign-in-required' };
      if (result.status !== 'ok') this.failures.set(binding, { at: Date.now(), result });
      else this.failures.delete(binding);
      return result;
    } finally { this.reads.delete(binding); }
  }

  private async readOnce(workspacePath: string, binding: string): Promise<OllamaDashboardResult> {
    let window: BrowserWindow | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      window = this.createWindow(binding, false);
      const view = window;
      let redirectedToLogin = false;
      const signInRequired = new Promise<OllamaDashboardResult>(resolve => {
        const stopAtLogin = (event: { preventDefault(): void }, url: string, _inPlace?: boolean, mainFrame?: boolean) => {
          if (mainFrame === false || !isOllamaLoginNavigation(url) || isOllamaUsagePage(url)) return;
          // A hidden reader never needs to load an authentication page.
          redirectedToLogin = true;
          event.preventDefault();
          resolve({ status: 'sign-in-required' });
        };
        view.webContents.on('will-redirect', stopAtLogin);
        view.webContents.on('will-navigate', stopAtLogin);
      });
      const timeout = new Promise<OllamaDashboardResult>(resolve => {
        timer = setTimeout(() => { if (!view.isDestroyed()) view.destroy(); resolve(readError()); }, READ_TIMEOUT_MS);
      });
      const operation = (async () => {
        try { await view.loadURL(SETTINGS_URL); }
        catch { return redirectedToLogin ? { status: 'sign-in-required' } as const : readError(); }
        const result = await this.extract(view);
        return getOllamaDashboardBinding(workspacePath) === binding ? result : { status: 'sign-in-required' } as const;
      })();
      return await Promise.race([operation, signInRequired, timeout]);
    } catch { return readError(); }
    finally { clearTimeout(timer); if (window && !window.isDestroyed()) window.destroy(); }
  }

  /** Only an explicit settings/popover action calls this; reads never open login UI. */
  connect(workspacePath: string, parent?: BrowserWindow): Promise<OllamaDashboardResult> {
    const binding = getOllamaDashboardBinding(workspacePath);
    if (this.forgetting.has(binding)) return Promise.resolve({ status: 'sign-in-required' });
    this.forgotten.delete(binding);
    this.failures.delete(binding);
    const existing = this.logins.get(binding);
    if (existing) { if (!existing.window.isDestroyed()) existing.window.focus(); return existing.promise; }
    const window = this.createWindow(binding, true, parent);
    let finish!: (result: OllamaDashboardResult) => void;
    const promise = new Promise<OllamaDashboardResult>(resolve => { finish = resolve; });
    let settled = false;
    let reading = false;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    const complete = (result: OllamaDashboardResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(readTimer);
      this.logins.delete(binding); this.failures.delete(binding);
      finish(result);
      if (!window.isDestroyed()) window.destroy();
    };
    const timer = setTimeout(() => complete({ status: 'sign-in-required' }), LOGIN_TIMEOUT_MS);
    this.logins.set(binding, { promise, window, cancel: () => complete({ status: 'sign-in-required' }) });
    window.on('closed', () => complete({ status: 'sign-in-required' }));
    window.webContents.on('did-finish-load', async () => {
      if (settled || reading || window.isDestroyed()) return;
      const url = window.webContents.getURL();
      if (url === 'https://ollama.com/dashboard') {
        void window.loadURL(SETTINGS_URL).catch(() => complete(readError()));
        return;
      }
      if (!isOllamaUsagePage(url)) return;
      reading = true;
      readTimer = setTimeout(() => complete(readError()), READ_TIMEOUT_MS);
      try {
        const result = await this.extract(window);
        complete(getOllamaDashboardBinding(workspacePath) === binding ? result : { status: 'sign-in-required' });
      } catch { complete(readError()); }
    });
    void window.loadURL(SETTINGS_URL).catch(() => complete(readError()));
    return promise;
  }

  forget(workspacePath: string): Promise<void> {
    const binding = getOllamaDashboardBinding(workspacePath);
    const existing = this.forgetting.get(binding);
    if (existing) return existing;
    // Block new reads before awaiting old work. A failed clear stays disconnected
    // until the user explicitly reconnects; old browser data cannot republish itself.
    this.forgotten.add(binding);
    this.logins.get(binding)?.cancel();
    const pending = this.reads.get(binding);
    const operation = (async () => {
      if (pending) await pending;
      await session.fromPartition(ollamaUsagePartition(binding)).clearStorageData();
      this.failures.delete(binding);
    })();
    this.forgetting.set(binding, operation);
    void operation.finally(() => this.forgetting.delete(binding)).catch(() => {});
    return operation;
  }

  stop(): void {
    for (const login of [...this.logins.values()]) login.cancel();
    for (const window of [...this.windows]) if (!window.isDestroyed()) window.destroy();
    this.failures.clear();
    this.forgotten.clear();
  }
}

export const ollamaDashboardScraper = new OllamaDashboardScraperImpl();
