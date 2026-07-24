/**
 * Thin wrapper around the BrowserSessionService IPC channels.
 *
 * Centralizes channel names + response shapes so React components can stay
 * focused on UI. State changes are pushed via 'browser-session:state-changed'
 * events; consumers subscribe through subscribeToStateChanges().
 */

export interface BrowserNavigationState {
  sessionId: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  lastError?: { code: number; description: string };
}

export interface BrowserSessionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface IpcResponse<T = unknown> {
  success: boolean;
  error?: string;
  state?: BrowserNavigationState | null;
  url?: string;
  imageBase64?: string;
  mimeType?: string;
  data?: T;
  result?: unknown;
  info?: unknown;
  sessionIds?: string[];
  path?: string;
}

export interface BrowserCreateOptions {
  partition?: string;
  /** Create an agent-owned session in the shared off-screen host window. */
  headless?: boolean;
  viewport?: { width: number; height: number };
}

/** Target for click/type/scroll: a CSS selector or a getPageInfo index. */
export interface BrowserTarget {
  selector?: string;
  index?: number;
}

/**
 * Virtual-path prefix for fileless browser tabs. A tab path looks like
 * `virtual://com.nimbalyst.browser/<tabId>?title=…&url=…`. The host's
 * CustomEditorRegistry routes this prefix to BrowserSessionEditor (declared in
 * the manifest as `virtual://com.nimbalyst.browser/*`), and the path is what
 * persists across restart — so the URL travels in the path.
 */
export const BROWSER_VIRTUAL_PREFIX = 'virtual://com.nimbalyst.browser/';

/** Parse a fileless browser tab path back into its parts. */
export function parseVirtualBrowserPath(path: string): {
  tabId: string;
  sessionId: string;
  url: string;
  title: string;
} {
  const rest = path.slice(BROWSER_VIRTUAL_PREFIX.length);
  const q = rest.indexOf('?');
  const tabId = q >= 0 ? rest.slice(0, q) : rest;
  const params = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : '');
  return {
    tabId,
    // Stable session id derived from the tab id so restore reuses one session.
    sessionId: `browser-virtual:${tabId}`,
    url: params.get('url') || 'about:blank',
    title: params.get('title') || 'New Tab',
  };
}

function getApi(): { invoke: (ch: string, ...args: unknown[]) => Promise<unknown>; on: (ch: string, cb: (...args: unknown[]) => void) => () => void } {
  const api = (window as unknown as { electronAPI?: { invoke: (ch: string, ...args: unknown[]) => Promise<unknown>; on: (ch: string, cb: (...args: unknown[]) => void) => () => void } }).electronAPI;
  if (!api) {
    throw new Error('Browser extension requires electronAPI');
  }
  return api;
}

const sessionIdsByHost = new WeakMap<object, string>();

function generateSessionId(filePath: string): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `browser:${filePath}:${uuid}`;
}

async function callIpc<T = unknown>(channel: string, payload: unknown): Promise<IpcResponse<T>> {
  const result = (await getApi().invoke(channel, payload)) as IpcResponse<T>;
  return result;
}

export async function createBrowserSession(
  sessionId: string,
  url: string,
  options?: BrowserCreateOptions,
): Promise<BrowserNavigationState> {
  const res = await callIpc('browser-session:create', {
    sessionId,
    url,
    partition: options?.partition,
    headless: options?.headless,
    viewport: options?.viewport,
  });
  if (!res.success || !res.state) {
    throw new Error(res.error || 'Failed to create browser session');
  }
  return res.state;
}

export async function listBrowserSessions(): Promise<string[]> {
  const res = await callIpc('browser-session:list-sessions', {});
  return res.sessionIds ?? [];
}

export async function evaluateInBrowserSession(sessionId: string, script: string): Promise<unknown> {
  const res = await callIpc('browser-session:evaluate', { sessionId, script });
  if (!res.success) throw new Error(res.error || 'evaluate failed');
  return res.result;
}

export async function getBrowserPageInfo(sessionId: string): Promise<unknown> {
  const res = await callIpc('browser-session:get-page-info', { sessionId });
  if (!res.success) throw new Error(res.error || 'get-page-info failed');
  return res.info;
}

export async function clickInBrowserSession(
  sessionId: string,
  target: BrowserTarget & { x?: number; y?: number },
): Promise<void> {
  const res = await callIpc('browser-session:click', { sessionId, ...target });
  if (!res.success) throw new Error(res.error || 'click failed');
}

export async function typeInBrowserSession(
  sessionId: string,
  args: BrowserTarget & { text: string; clear?: boolean },
): Promise<void> {
  const res = await callIpc('browser-session:type', { sessionId, ...args });
  if (!res.success) throw new Error(res.error || 'type failed');
}

export async function scrollBrowserSession(
  sessionId: string,
  args: BrowserTarget & { dx?: number; dy?: number },
): Promise<void> {
  const res = await callIpc('browser-session:scroll', { sessionId, ...args });
  if (!res.success) throw new Error(res.error || 'scroll failed');
}

export async function screenshotBrowserSessionToFile(
  sessionId: string,
  workspacePath: string,
  label?: string,
): Promise<string> {
  const res = await callIpc('browser-session:screenshot-to-file', { sessionId, workspacePath, label });
  if (!res.success || !res.path) {
    throw new Error(res.error || 'screenshot-to-file failed');
  }
  return res.path;
}

export async function destroyBrowserSession(sessionId: string): Promise<void> {
  await callIpc('browser-session:destroy', { sessionId });
}

export async function attachBrowserSession(
  sessionId: string,
  bounds: BrowserSessionBounds,
): Promise<void> {
  const res = await callIpc('browser-session:attach', { sessionId, bounds });
  if (!res.success) throw new Error(res.error || 'attach failed');
}

export async function detachBrowserSession(sessionId: string): Promise<void> {
  await callIpc('browser-session:detach', { sessionId });
}

export async function setBrowserSessionBounds(
  sessionId: string,
  bounds: BrowserSessionBounds,
): Promise<void> {
  await callIpc('browser-session:set-bounds', { sessionId, bounds });
}

export async function navigateBrowserSession(sessionId: string, url: string): Promise<void> {
  const res = await callIpc('browser-session:navigate', { sessionId, url });
  if (!res.success) throw new Error(res.error || 'navigate failed');
}

export async function reloadBrowserSession(sessionId: string): Promise<void> {
  await callIpc('browser-session:reload', { sessionId });
}

export async function goBackBrowserSession(sessionId: string): Promise<void> {
  await callIpc('browser-session:go-back', { sessionId });
}

export async function goForwardBrowserSession(sessionId: string): Promise<void> {
  await callIpc('browser-session:go-forward', { sessionId });
}

export async function captureBrowserScreenshot(sessionId: string): Promise<string> {
  const res = await callIpc('browser-session:screenshot', { sessionId });
  if (!res.success || !res.imageBase64) {
    throw new Error(res.error || 'screenshot failed');
  }
  return res.imageBase64;
}

export async function buildPreviewUrl(filePath: string, workspacePath?: string): Promise<string> {
  const res = await callIpc('browser-session:build-preview-url', { filePath, workspacePath });
  if (!res.success || !res.url) {
    throw new Error(res.error || 'build-preview-url failed');
  }
  return res.url;
}

/**
 * Subscribe to navigation state changes. The main process broadcasts every
 * state mutation; the callback only fires for the matching session id.
 */
export function subscribeToStateChanges(
  sessionId: string,
  callback: (state: BrowserNavigationState) => void,
): () => void {
  const handler = (state: unknown): void => {
    const s = state as BrowserNavigationState;
    if (s && s.sessionId === sessionId) callback(s);
  };
  return getApi().on('browser-session:state-changed', handler);
}

/**
 * Subscribe to external-navigation requests (target=_blank, window.open).
 */
export function subscribeToExternalNav(
  sessionId: string,
  callback: (url: string) => void,
): () => void {
  const handler = (payload: unknown): void => {
    const p = payload as { sessionId: string; url: string };
    if (p && p.sessionId === sessionId) callback(p.url);
  };
  return getApi().on('browser-session:external-nav', handler);
}

/**
 * Generate a stable session id for one editor host instance. The WeakMap keeps
 * the same id across custom-editor remounts in the same tab/window (for
 * example source-mode toggles) while naturally isolating duplicate opens of
 * the same file in other windows or tabs.
 */
export function getOrCreateSessionIdForHost(host: object, filePath: string): string {
  const existing = sessionIdsByHost.get(host);
  if (existing) {
    return existing;
  }
  const next = generateSessionId(filePath);
  sessionIdsByHost.set(host, next);
  return next;
}
