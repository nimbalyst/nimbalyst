/**
 * BrowserSessionService
 *
 * Main-process owner of native browser surfaces. Each session is backed by a
 * single `WebContentsView` which is attached as a child of a host BrowserWindow.
 * The renderer-side custom editor reserves a rectangle on its tab and asks this
 * service to position the WebContentsView over that rectangle. Bounds, focus,
 * navigation, and screenshot capture all live here -- the renderer never owns
 * the chromium surface directly.
 *
 * Why a host-level primitive instead of an iframe:
 *   - X-Frame-Options / CSP frame-ancestors break iframes for most real sites.
 *   - WebContentsView is a real Chromium browsing context with its own session
 *     partition, so we can run isolated navigation, capture full-page pixels,
 *     and (later) wire devtools without the renderer process being involved.
 *
 * Lifecycle:
 *   createSession() -> view created, navigated to URL (loads in background)
 *   attachToWindow() -> view installed as childView of a BrowserWindow + positioned
 *   setBounds() / detachFromWindow() -> renderer can reflow / unmount as tab changes
 *   destroySession() -> view torn down, webContents closed
 *
 * The view is sized in CSS pixels and positioned in the host window's content
 * area; conversion to device pixels happens automatically inside Electron.
 */

import { WebContentsView, BrowserWindow, session as electronSession } from 'electron';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { ensureNimPreviewProtocolForSession } from '../protocols/nimPreviewProtocol';
import { installMicrophoneGate } from '../mediaPermissionGate';

export interface BrowserSessionInitOptions {
  /** Stable session id chosen by the caller. */
  sessionId: string;
  /** Initial URL to load. May be a `nim-preview://`, `http(s)://`, or `about:blank` URL. */
  url: string;
  /**
   * Session partition. Plain names are in-memory and isolated to this app
   * run; use a `persist:` prefix only when the caller explicitly wants
   * Chromium storage to survive restarts.
   * Falls back to the in-memory `'preview'` partition if omitted.
   */
  partition?: string;
  /**
   * Agent-owned headless session. When true the view is never attached to a
   * visible window; offscreen rendering keeps the page painting so navigation,
   * `capturePage()`, and DOM interaction still work. Used by AI tools that
   * drive a browser without the user opening an editor tab.
   */
  headless?: boolean;
  /**
   * Logical viewport for a headless session, in CSS pixels. Defaults to a
   * desktop preset. Ignored for attached (editor-backed) sessions, whose size
   * is driven by the editor placeholder's bounds.
   */
  viewport?: { width: number; height: number };
}

/** Default headless viewport when the caller doesn't specify one. */
const DEFAULT_HEADLESS_VIEWPORT = { width: 1280, height: 800 };

/**
 * How long a headless (agent-owned) session may sit unused before we reap it.
 *
 * Agents routinely forget to call `browser.close_session`, and a leaked headless
 * session keeps the shared host window alive for the rest of the app run. That
 * window has to be *shown* to paint and macOS always drags it onto a real
 * display, so `setOpacity(0)` is the only thing standing between the user and a
 * frameless window they cannot close. Reaping idle sessions means we are not
 * relying on that single defence for days at a time.
 */
const HEADLESS_IDLE_TTL_MS = 5 * 60 * 1000;

/** How often the reaper checks for idle headless sessions. */
const HEADLESS_REAP_INTERVAL_MS = 60 * 1000;

export interface BrowserSessionBounds {
  /** CSS pixels, relative to the host window's content area. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserNavigationState {
  sessionId: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Populated when the most recent navigation failed. */
  lastError?: { code: number; description: string };
}

interface SessionEntry {
  sessionId: string;
  partitionName: string;
  view: WebContentsView;
  hostWindow: BrowserWindow | null;
  bounds: BrowserSessionBounds | null;
  state: BrowserNavigationState;
  /** Agent-owned session parked in the shared off-screen host window. */
  headless: boolean;
  /** `Date.now()` of the last operation on this session; drives idle reaping. */
  lastUsedAt: number;
}

/** Minimal shape the idle reaper needs; keeps the decision unit-testable. */
export interface ReapCandidate {
  sessionId: string;
  headless: boolean;
  lastUsedAt: number;
}

/**
 * Pure-function reaper policy. Returns the ids of headless sessions that have
 * been idle for at least `ttlMs`. Editor-backed sessions are never reaped --
 * the user owns those, and their host window is a real app window.
 */
export function selectIdleHeadlessSessions(
  candidates: ReapCandidate[],
  now: number,
  ttlMs: number,
): string[] {
  return candidates
    .filter((c) => c.headless && now - c.lastUsedAt >= ttlMs)
    .map((c) => c.sessionId);
}

/**
 * Pure-function bounds clamper. Exposed for unit tests so we can verify that
 * a negative or oversized rect (which Electron silently accepts) is corrected
 * before we hand it to `view.setBounds`.
 */
export function clampBounds(
  bounds: BrowserSessionBounds,
  container: { width: number; height: number },
): BrowserSessionBounds {
  const x = Math.max(0, Math.floor(bounds.x));
  const y = Math.max(0, Math.floor(bounds.y));
  // Width/height are non-negative integers; if the requested rect extends past
  // the container we clip so we never produce a view with negative dims.
  const width = Math.max(0, Math.min(Math.floor(bounds.width), container.width - x));
  const height = Math.max(0, Math.min(Math.floor(bounds.height), container.height - y));
  return { x, y, width, height };
}

/**
 * Pure-function URL allow-list. Centralized so the renderer-facing API and the
 * service implementation agree on what counts as a safe URL to navigate to.
 *
 * Allowed schemes:
 *   - `http:` / `https:` (remote pages -- iframe-blocking sites still load here
 *     because WebContentsView is not an iframe).
 *   - `nim-preview:` (workspace-served local HTML).
 *   - `about:blank` (used to clear the view).
 *
 * Explicitly blocked:
 *   - `file:` (workspace HTML must go through `nim-preview:` so we can enforce
 *     workspace scoping in one place).
 *   - `javascript:`, `data:` (XSS surface).
 */
export function isAllowedBrowserUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (url === 'about:blank') return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'http:' ||
    parsed.protocol === 'https:' ||
    parsed.protocol === 'nim-preview:'
  );
}

export function resolveBrowserPartitionName(partition?: string): string {
  const normalized = partition?.trim() || 'preview';
  return normalized.startsWith('persist:') ? normalized : `browser-${normalized}`;
}

export class BrowserSessionService extends EventEmitter {
  private static instance: BrowserSessionService | null = null;

  private sessions = new Map<string, SessionEntry>();

  /**
   * Sessions track a single host window only; when that window is destroyed we
   * proactively tear the session down so we don't leak WebContentsView objects.
   * The map of teardown listeners is keyed by window id so we can detach on
   * `detachFromWindow` without leaving stale closures behind.
   */
  private windowCloseListeners = new Map<number, Set<string>>();

  /**
   * Shared host window for headless (agent-owned) sessions. Created lazily on
   * the first headless session and *shown* so Chromium actually composits the
   * child views (a hidden/`show:false` window suspends painting, which fails
   * capturePage()), but held at opacity 0 so the user never sees it. Torn down
   * when the last headless session goes away, or when the idle reaper collects
   * the last leaked session.
   */
  private headlessHostWindow: BrowserWindow | null = null;

  /** Interval that reaps idle headless sessions; only runs while any exist. */
  private headlessReapTimer: NodeJS.Timeout | null = null;

  private constructor() {
    super();
  }

  public static getInstance(): BrowserSessionService {
    if (!BrowserSessionService.instance) {
      BrowserSessionService.instance = new BrowserSessionService();
    }
    return BrowserSessionService.instance;
  }

  /**
   * Reset the singleton. Tests only.
   */
  public static __resetForTests(): void {
    if (BrowserSessionService.instance) {
      BrowserSessionService.instance.cleanup();
    }
    BrowserSessionService.instance = null;
  }

  // ============ SESSION LIFECYCLE ============

  public hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  public listSessions(): string[] {
    return [...this.sessions.keys()];
  }

  public getState(sessionId: string): BrowserNavigationState | null {
    const entry = this.sessions.get(sessionId);
    return entry ? { ...entry.state } : null;
  }

  public createSession(opts: BrowserSessionInitOptions): BrowserNavigationState {
    const existing = this.sessions.get(opts.sessionId);
    if (existing) {
      const requestedPartition = resolveBrowserPartitionName(opts.partition);
      if (
        existing.state.url !== opts.url ||
        existing.partitionName !== requestedPartition
      ) {
        throw new Error(
          `Browser session ${opts.sessionId} already exists with different configuration`,
        );
      }
      logger.main.warn(`[BrowserSessionService] Session already exists: ${opts.sessionId}`);
      return { ...existing.state };
    }
    if (!isAllowedBrowserUrl(opts.url)) {
      throw new Error(`Disallowed browser URL: ${opts.url}`);
    }

    const partitionName = resolveBrowserPartitionName(opts.partition);
    const ses = electronSession.fromPartition(partitionName);
    // Belt-and-suspenders with the global session-created hook: browsed web
    // content must remain microphone-denied even after Voice Mode is granted.
    installMicrophoneGate(ses, {
      allowWhenGranted: false,
      label: partitionName,
    });
    // Custom partitions do not inherit the default session's protocol
    // handlers; without this, nim-preview:// is an unknown scheme in the view
    // (issue #612).
    ensureNimPreviewProtocolForSession(ses);
    const headless = opts.headless === true;

    const view = new WebContentsView({
      webPreferences: {
        // No preload script: this view runs untrusted web content. Renderer
        // requests for IPC must go through the host BrowserWindow's preload.
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        session: ses,
      },
    });

    const entry: SessionEntry = {
      sessionId: opts.sessionId,
      partitionName,
      view,
      hostWindow: null,
      bounds: null,
      headless,
      lastUsedAt: Date.now(),
      state: {
        sessionId: opts.sessionId,
        url: opts.url,
        title: '',
        isLoading: true,
        canGoBack: false,
        canGoForward: false,
      },
    };
    this.sessions.set(opts.sessionId, entry);

    this.wireWebContentsEvents(entry);

    if (headless) {
      // A WebContentsView only paints while attached to a rendering window;
      // capturePage() returns an empty buffer otherwise (WebContentsView
      // ignores the `offscreen` webPreference). Park headless views in a shared
      // off-screen host window so navigation, screenshots, and input all work
      // without the user ever seeing the surface.
      const vp = opts.viewport ?? DEFAULT_HEADLESS_VIEWPORT;
      const host = this.getOrCreateHeadlessHostWindow(vp);
      this.attachToWindow(opts.sessionId, host, { x: 0, y: 0, width: vp.width, height: vp.height });
      this.startHeadlessReaper();
    }

    // Kick off the initial load. We intentionally do not await -- the renderer
    // will see navigation events via the state-changed signal.
    void view.webContents.loadURL(opts.url).catch((err) => {
      // loadURL rejects on network errors / aborts; the will-fail-load handler
      // also fires, but logging here gives us a single error to grep.
      logger.main.warn(
        `[BrowserSessionService] loadURL failed for ${opts.sessionId}: ${(err as Error)?.message}`,
      );
    });

    logger.main.info(
      `[BrowserSessionService] Created session ${opts.sessionId} url=${opts.url} partition=${partitionName}`,
    );
    return { ...entry.state };
  }

  public destroySession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    if (entry.hostWindow && !entry.hostWindow.isDestroyed()) {
      try {
        entry.hostWindow.contentView.removeChildView(entry.view);
      } catch (err) {
        // removeChildView throws if the view is not a child; ignore -- we are
        // tearing down regardless.
        logger.main.debug(
          `[BrowserSessionService] removeChildView during destroy threw for ${sessionId}: ${(err as Error)?.message}`,
        );
      }
      this.removeWindowCloseListener(entry.hostWindow.id, sessionId);
    }

    try {
      // close() on the view's webContents tears down the renderer process.
      entry.view.webContents.close();
    } catch (err) {
      logger.main.debug(
        `[BrowserSessionService] webContents.close threw for ${sessionId}: ${(err as Error)?.message}`,
      );
    }

    this.sessions.delete(sessionId);
    this.maybeTeardownHeadlessHost();
    logger.main.info(`[BrowserSessionService] Destroyed session ${sessionId}`);
  }

  // ============ ATTACH / DETACH ============

  public attachToWindow(
    sessionId: string,
    hostWindow: BrowserWindow,
    bounds: BrowserSessionBounds,
  ): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`No browser session: ${sessionId}`);
    }
    if (hostWindow.isDestroyed()) {
      throw new Error('Host window is destroyed');
    }

    // If we're already attached to a different window, detach first so we
    // never end up parented in two trees simultaneously.
    if (entry.hostWindow && entry.hostWindow !== hostWindow && !entry.hostWindow.isDestroyed()) {
      try {
        entry.hostWindow.contentView.removeChildView(entry.view);
      } catch {
        // ignore -- detach is best-effort
      }
      this.removeWindowCloseListener(entry.hostWindow.id, sessionId);
    }

    hostWindow.contentView.addChildView(entry.view);
    entry.hostWindow = hostWindow;
    this.installWindowCloseListener(hostWindow, sessionId);

    this.setBounds(sessionId, bounds);
  }

  public detachFromWindow(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.hostWindow) return;
    if (!entry.hostWindow.isDestroyed()) {
      try {
        entry.hostWindow.contentView.removeChildView(entry.view);
      } catch (err) {
        logger.main.debug(
          `[BrowserSessionService] detach removeChildView threw for ${sessionId}: ${(err as Error)?.message}`,
        );
      }
      this.removeWindowCloseListener(entry.hostWindow.id, sessionId);
    }
    entry.hostWindow = null;
    entry.bounds = null;
  }

  public setBounds(sessionId: string, bounds: BrowserSessionBounds): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.hostWindow || entry.hostWindow.isDestroyed()) return;

    const [containerWidth, containerHeight] = entry.hostWindow.getContentSize();
    const clamped = clampBounds(bounds, { width: containerWidth, height: containerHeight });
    entry.bounds = clamped;
    entry.view.setBounds(clamped);
  }

  // ============ NAVIGATION ============

  public navigate(sessionId: string, url: string): void {
    const entry = this.requireEntry(sessionId);
    if (!isAllowedBrowserUrl(url)) {
      throw new Error(`Disallowed browser URL: ${url}`);
    }
    entry.state.lastError = undefined;
    void entry.view.webContents.loadURL(url).catch((err) => {
      logger.main.warn(
        `[BrowserSessionService] navigate loadURL failed for ${sessionId}: ${(err as Error)?.message}`,
      );
    });
  }

  public reload(sessionId: string): void {
    const entry = this.requireEntry(sessionId);
    entry.view.webContents.reload();
  }

  public goBack(sessionId: string): void {
    const entry = this.requireEntry(sessionId);
    // webContents.navigationHistory.goBack was added in Electron 25+, but
    // canGoBack/goBack on webContents itself is the long-standing API.
    if (entry.view.webContents.navigationHistory.canGoBack()) {
      entry.view.webContents.navigationHistory.goBack();
    }
  }

  public goForward(sessionId: string): void {
    const entry = this.requireEntry(sessionId);
    if (entry.view.webContents.navigationHistory.canGoForward()) {
      entry.view.webContents.navigationHistory.goForward();
    }
  }

  // ============ SCREENSHOT ============

  public async captureScreenshot(sessionId: string): Promise<Buffer> {
    const entry = this.requireEntry(sessionId);
    // Both attached and headless views render into a window (headless ones into
    // the shared off-screen host window), so capturePage() grabs live pixels.
    const nativeImage = await entry.view.webContents.capturePage();
    return nativeImage.toPNG();
  }

  // ============ INTERACTION (agentic control) ============

  /**
   * Run arbitrary JavaScript in the page and return its (serializable) result.
   * `userGesture: true` lets the script do gesture-gated things like focus().
   * This is the powerful, trust-the-agent primitive; the page is whatever the
   * session navigated to, still subject to the URL allow-list.
   */
  public async evaluate(sessionId: string, script: string): Promise<unknown> {
    const entry = this.requireEntry(sessionId);
    return await entry.view.webContents.executeJavaScript(script, true);
  }

  /**
   * Snapshot of the page for an agent: url, title, a truncated text dump, and an
   * indexed list of interactive elements. Each interactive element is tagged
   * in-page with `data-nim-idx` so a follow-up `click({ index })` can target it
   * without the agent needing CSS selectors.
   */
  public async getPageInfo(sessionId: string): Promise<unknown> {
    const entry = this.requireEntry(sessionId);
    const script = `(() => {
      const sel = 'a[href], button, input, textarea, select, [role=button], [role=link], [onclick], [contenteditable=""], [contenteditable="true"]';
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none';
      };
      const els = [...document.querySelectorAll(sel)].filter(isVisible);
      const interactive = els.slice(0, 200).map((el, i) => {
        el.setAttribute('data-nim-idx', String(i));
        const r = el.getBoundingClientRect();
        return {
          index: i,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || undefined,
          role: el.getAttribute('role') || undefined,
          text: (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 120),
          href: el.getAttribute('href') || undefined,
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        };
      });
      return {
        url: location.href,
        title: document.title,
        text: (document.body ? document.body.innerText : '').trim().slice(0, 5000),
        interactive,
        truncated: els.length > 200,
      };
    })()`;
    return await entry.view.webContents.executeJavaScript(script, true);
  }

  /**
   * Resolve an interaction target to a viewport point in CSS pixels, scrolling
   * it into view first. Accepts a CSS selector or a `data-nim-idx` index from a
   * prior getPageInfo(). Returns null if the element can't be found.
   */
  private async resolveTargetPoint(
    entry: SessionEntry,
    target: { selector?: string; index?: number },
  ): Promise<{ x: number; y: number } | null> {
    const locator =
      typeof target.index === 'number'
        ? `document.querySelector('[data-nim-idx="' + ${JSON.stringify(String(target.index))} + '"]')`
        : `document.querySelector(${JSON.stringify(target.selector ?? '')})`;
    const script = `(() => {
      const el = ${locator};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`;
    const point = (await entry.view.webContents.executeJavaScript(script, true)) as
      | { x: number; y: number }
      | null;
    return point;
  }

  /**
   * Click via real Chromium input events so framework handlers fire. Target can
   * be a selector, a getPageInfo index, or explicit CSS-pixel coordinates.
   */
  public async click(
    sessionId: string,
    target: { selector?: string; index?: number; x?: number; y?: number },
  ): Promise<void> {
    const entry = this.requireEntry(sessionId);
    let point: { x: number; y: number } | null;
    if (typeof target.x === 'number' && typeof target.y === 'number') {
      point = { x: target.x, y: target.y };
    } else {
      point = await this.resolveTargetPoint(entry, target);
    }
    if (!point) {
      throw new Error('Click target not found');
    }
    const wc = entry.view.webContents;
    const x = Math.round(point.x);
    const y = Math.round(point.y);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  /**
   * Type text into an element. Focuses the target (selector or index), optionally
   * clears it, then sends real character events so controlled inputs (React et al)
   * see genuine input. If no target is given, types into whatever has focus.
   */
  public async type(
    sessionId: string,
    args: { selector?: string; index?: number; text: string; clear?: boolean },
  ): Promise<void> {
    const entry = this.requireEntry(sessionId);
    const wc = entry.view.webContents;

    if (args.selector !== undefined || typeof args.index === 'number') {
      const locator =
        typeof args.index === 'number'
          ? `document.querySelector('[data-nim-idx="' + ${JSON.stringify(String(args.index))} + '"]')`
          : `document.querySelector(${JSON.stringify(args.selector ?? '')})`;
      const focused = (await wc.executeJavaScript(
        `(() => { const el = ${locator}; if (!el) return false; el.focus(); ${
          args.clear ? "if ('value' in el) el.value = ''; else el.textContent = '';" : ''
        } return true; })()`,
        true,
      )) as boolean;
      if (!focused) {
        throw new Error('Type target not found');
      }
    } else if (args.clear) {
      // Clear the currently-focused field via select-all + delete.
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control', 'meta'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control', 'meta'] });
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Delete' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Delete' });
    }

    for (const ch of args.text) {
      wc.sendInputEvent({ type: 'char', keyCode: ch });
    }
  }

  /** Scroll the page (or a selector's container) by a delta or to an element. */
  public async scroll(
    sessionId: string,
    args: { selector?: string; index?: number; dx?: number; dy?: number },
  ): Promise<void> {
    const entry = this.requireEntry(sessionId);
    if (args.selector !== undefined || typeof args.index === 'number') {
      await this.resolveTargetPoint(entry, args); // scrollIntoView side effect
      return;
    }
    const dx = Number(args.dx) || 0;
    const dy = Number(args.dy) || 0;
    await entry.view.webContents.executeJavaScript(
      `window.scrollBy(${dx}, ${dy}); true;`,
      true,
    );
  }

  // ============ INTERNAL ============

  /**
   * Lazily create the shared off-screen host window for headless sessions.
   * Sized to fit the largest requested viewport and parked off all displays.
   */
  private getOrCreateHeadlessHostWindow(viewport: { width: number; height: number }): BrowserWindow {
    if (this.headlessHostWindow && !this.headlessHostWindow.isDestroyed()) {
      // Grow the host if a later session needs a bigger viewport.
      const [w, h] = this.headlessHostWindow.getContentSize();
      if (viewport.width > w || viewport.height > h) {
        this.headlessHostWindow.setContentSize(
          Math.max(w, viewport.width),
          Math.max(h, viewport.height),
        );
      }
      return this.headlessHostWindow;
    }

    const win = new BrowserWindow({
      width: viewport.width,
      height: viewport.height,
      // Requested off-display. macOS does NOT honour this: AppKit constrains the
      // frame back onto a real screen the moment the window is ordered in, even
      // when it is frameless. Measured on a two-display Mac: a window asking for
      // (-32000, -32000) lands at (-1352, 304) -- i.e. squarely on the second
      // monitor. The request is kept because it is honoured on Windows/Linux;
      // `setOpacity(0)` below is what actually hides it on macOS.
      x: -32000,
      y: -32000,
      show: false,
      focusable: false,
      skipTaskbar: true,
      frame: false,
    });
    // The window must be *shown* for its child views to composite -- a window
    // that is never shown fails capturePage() outright with "Current display
    // surface not available for capture". showInactive() forces compositing
    // without stealing focus from the user's real window.
    win.showInactive();
    win.setContentSize(viewport.width, viewport.height);
    // Since macOS insists on placing it on a display, make it invisible there.
    // Opacity 0 does not suppress compositing: child views keep painting and
    // capturePage() still returns full-fidelity pixels.
    win.setOpacity(0);
    // Belt and braces -- a frameless, non-focusable window has no close button
    // and no Cmd+W, so it must never be able to swallow the user's clicks.
    win.setIgnoreMouseEvents(true);

    win.once('closed', () => {
      if (this.headlessHostWindow === win) this.headlessHostWindow = null;
    });

    this.headlessHostWindow = win;
    logger.main.info(
      `[BrowserSessionService] Created headless host window at ${JSON.stringify(win.getBounds())} (opacity 0)`,
    );
    return win;
  }

  /** Destroy the headless host window once no headless sessions remain. */
  private maybeTeardownHeadlessHost(): void {
    if (!this.headlessHostWindow) return;
    const stillHeadless = [...this.sessions.values()].some((e) => e.headless);
    if (stillHeadless) return;
    this.stopHeadlessReaper();
    if (!this.headlessHostWindow.isDestroyed()) {
      this.headlessHostWindow.destroy();
    }
    this.headlessHostWindow = null;
  }

  /**
   * Start the idle reaper if it isn't already running. Every operation routes
   * through `requireEntry`, which refreshes `lastUsedAt`, so an actively-driven
   * session is never reaped mid-use.
   */
  private startHeadlessReaper(): void {
    if (this.headlessReapTimer) return;
    this.headlessReapTimer = setInterval(() => {
      this.reapIdleHeadlessSessions();
    }, HEADLESS_REAP_INTERVAL_MS);
    // Don't hold the event loop open on our account.
    this.headlessReapTimer.unref?.();
  }

  private stopHeadlessReaper(): void {
    if (!this.headlessReapTimer) return;
    clearInterval(this.headlessReapTimer);
    this.headlessReapTimer = null;
  }

  /** Destroy headless sessions that have gone untouched for the idle TTL. */
  private reapIdleHeadlessSessions(): void {
    const expired = selectIdleHeadlessSessions(
      [...this.sessions.values()].map((e) => ({
        sessionId: e.sessionId,
        headless: e.headless,
        lastUsedAt: e.lastUsedAt,
      })),
      Date.now(),
      HEADLESS_IDLE_TTL_MS,
    );
    for (const sessionId of expired) {
      logger.main.info(
        `[BrowserSessionService] Reaping idle headless session ${sessionId} (unused for >${HEADLESS_IDLE_TTL_MS}ms)`,
      );
      this.destroySession(sessionId);
    }
    if (![...this.sessions.values()].some((e) => e.headless)) {
      this.stopHeadlessReaper();
    }
  }

  private requireEntry(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`No browser session: ${sessionId}`);
    }
    // Any operation counts as use and pushes back the idle deadline.
    entry.lastUsedAt = Date.now();
    return entry;
  }

  private wireWebContentsEvents(entry: SessionEntry): void {
    const wc = entry.view.webContents;

    const emitStateChanged = (): void => {
      if (!this.sessions.has(entry.sessionId)) return;
      this.emit('state-changed', { ...entry.state });
    };

    wc.on('did-start-loading', () => {
      entry.state.isLoading = true;
      emitStateChanged();
    });
    wc.on('did-stop-loading', () => {
      entry.state.isLoading = false;
      entry.state.canGoBack = wc.navigationHistory.canGoBack();
      entry.state.canGoForward = wc.navigationHistory.canGoForward();
      emitStateChanged();
    });
    wc.on('did-navigate', (_event, url) => {
      entry.state.url = url;
      entry.state.canGoBack = wc.navigationHistory.canGoBack();
      entry.state.canGoForward = wc.navigationHistory.canGoForward();
      emitStateChanged();
    });
    wc.on('did-navigate-in-page', (_event, url) => {
      entry.state.url = url;
      entry.state.canGoBack = wc.navigationHistory.canGoBack();
      entry.state.canGoForward = wc.navigationHistory.canGoForward();
      emitStateChanged();
    });
    wc.on('page-title-updated', (_event, title) => {
      entry.state.title = title;
      emitStateChanged();
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // Subframe failures (ads, third-party iframes) shouldn't disturb the
      // editor's surfaced state. Only flag failures of the main document.
      if (!isMainFrame) return;
      // -3 is ERR_ABORTED, which happens for any normal navigation away from a
      // pending load; surfacing it as a "failure" would be misleading.
      if (errorCode === -3) return;
      entry.state.lastError = {
        code: errorCode,
        description: errorDescription || 'Navigation failed',
      };
      entry.state.url = validatedURL || entry.state.url;
      entry.state.isLoading = false;
      emitStateChanged();
    });

    // Open `target=_blank` and any window.open() calls externally rather than
    // in a popup we don't own.
    wc.setWindowOpenHandler(({ url }) => {
      this.emit('external-navigation-requested', { sessionId: entry.sessionId, url });
      return { action: 'deny' };
    });
  }

  private installWindowCloseListener(hostWindow: BrowserWindow, sessionId: string): void {
    const windowId = hostWindow.id;
    let sessionsForWindow = this.windowCloseListeners.get(windowId);
    if (!sessionsForWindow) {
      sessionsForWindow = new Set();
      this.windowCloseListeners.set(windowId, sessionsForWindow);
      hostWindow.once('closed', () => {
        const sessions = this.windowCloseListeners.get(windowId);
        if (!sessions) return;
        for (const id of sessions) {
          // The window is gone; treat as detach + destroy. We can't call
          // contentView.removeChildView because the window is destroyed.
          const entry = this.sessions.get(id);
          if (entry) {
            entry.hostWindow = null;
            entry.bounds = null;
            this.destroySession(id);
          }
        }
        this.windowCloseListeners.delete(windowId);
      });
    }
    sessionsForWindow.add(sessionId);
  }

  private removeWindowCloseListener(windowId: number, sessionId: string): void {
    const sessions = this.windowCloseListeners.get(windowId);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (sessions.size === 0) {
      this.windowCloseListeners.delete(windowId);
    }
  }

  public cleanup(): void {
    this.stopHeadlessReaper();
    for (const sessionId of [...this.sessions.keys()]) {
      this.destroySession(sessionId);
    }
    this.windowCloseListeners.clear();
  }
}
