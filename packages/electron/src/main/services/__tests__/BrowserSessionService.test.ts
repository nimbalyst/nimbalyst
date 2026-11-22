// @vitest-environment node
/**
 * Tests for BrowserSessionService.
 *
 * The standalone helpers that drive bounds clamping and URL validation are
 * tested directly. Which window holds a session's view is tested against the
 * service itself, with Electron's window and view classes replaced by
 * in-memory fakes. Coverage of the IPC layer is intentionally left to
 * integration / E2E tests.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';

type Rect = { x: number; y: number; width: number; height: number };

const fakes = vi.hoisted(() => ({ createdWindows: [] as unknown[], createdViews: [] as unknown[] }));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  let nextWindowId = 1;

  class FakeContentView {
    children: unknown[] = [];
    addChildView(view: unknown): void {
      if (!this.children.includes(view)) this.children.push(view);
    }
    removeChildView(view: unknown): void {
      const index = this.children.indexOf(view);
      if (index < 0) throw new Error('view is not a child');
      this.children.splice(index, 1);
    }
  }

  class FakeWindow extends EventEmitter {
    readonly id = nextWindowId++;
    readonly contentView = new FakeContentView();
    readonly webContents = { getZoomFactor: (): number => 1 };
    private destroyed = false;
    private size: [number, number];

    constructor(opts: { width?: number; height?: number } = {}) {
      super();
      this.size = [opts.width ?? 1000, opts.height ?? 800];
      fakes.createdWindows.push(this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    getContentSize(): [number, number] {
      return this.size;
    }
    setContentSize(width: number, height: number): void {
      this.size = [width, height];
    }
    getBounds(): Rect {
      return { x: 0, y: 0, width: this.size[0], height: this.size[1] };
    }
    showInactive(): void {}
    setOpacity(): void {}
    setIgnoreMouseEvents(): void {}
    setAlwaysOnTop(): void {}
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
  }

  class FakeView {
    bounds: Rect | null = null;
    constructor() {
      fakes.createdViews.push(this);
    }
    readonly webContents = {
      on: (): void => {},
      setWindowOpenHandler: (): void => {},
      loadURL: (): Promise<void> => Promise.resolve(),
      close: (): void => {},
    };
    setBounds(bounds: Rect): void {
      this.bounds = bounds;
    }
  }

  return {
    BrowserWindow: FakeWindow,
    WebContentsView: FakeView,
    session: { fromPartition: (): object => ({}) },
  };
});

vi.mock('../../utils/logger', () => ({
  logger: { main: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../protocols/nimPreviewProtocol', () => ({
  ensureNimPreviewProtocolForSession: vi.fn(),
}));
vi.mock('../../mediaPermissionGate', () => ({ installMicrophoneGate: vi.fn() }));

import { BrowserWindow } from 'electron';
import {
  BrowserSessionService,
  clampBounds,
  clearEventsFor,
  clickEvents,
  keyEventsForText,
  isAllowedBrowserUrl,
  liesAboveOrLeftOfWindow,
  resolveBrowserPartitionName,
  scaleBoundsForZoom,
  selectIdleHeadlessSessions,
} from '../BrowserSessionService';

describe('scaleBoundsForZoom', () => {
  const cssRect = { x: 200, y: 100, width: 800, height: 600 };

  it('passes bounds through unchanged at 100%', () => {
    expect(scaleBoundsForZoom(cssRect, 1)).toEqual(cssRect);
  });

  it('scales origin and size up when the window is zoomed in', () => {
    // At 125% the renderer's CSS grid is 1.25x smaller than the window's
    // device-independent grid, so the native view sits further out and larger.
    expect(scaleBoundsForZoom(cssRect, 1.25)).toEqual({
      x: 250,
      y: 125,
      width: 1000,
      height: 750,
    });
  });

  it('scales down when the window is zoomed out', () => {
    expect(scaleBoundsForZoom(cssRect, 0.5)).toEqual({
      x: 100,
      y: 50,
      width: 400,
      height: 300,
    });
  });

  it('falls back to 1x for an unusable zoom factor', () => {
    for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(scaleBoundsForZoom(cssRect, factor)).toEqual(cssRect);
    }
  });
});

describe('clampBounds', () => {
  const container = { width: 1000, height: 800 };

  it('returns floored integer bounds for fractional input', () => {
    expect(clampBounds({ x: 10.7, y: 20.3, width: 100.9, height: 50.1 }, container)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it('clamps negative origin to zero', () => {
    expect(clampBounds({ x: -5, y: -10, width: 100, height: 100 }, container)).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it('clips width/height that overflow the container', () => {
    expect(clampBounds({ x: 950, y: 750, width: 200, height: 200 }, container)).toEqual({
      x: 950,
      y: 750,
      width: 50,
      height: 50,
    });
  });

  it('returns zero dimensions when the origin is at the container edge', () => {
    expect(clampBounds({ x: 1000, y: 800, width: 100, height: 100 }, container)).toEqual({
      x: 1000,
      y: 800,
      width: 0,
      height: 0,
    });
  });

  it('returns zero dimensions for a zero-size container', () => {
    expect(
      clampBounds({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 }),
    ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('liesAboveOrLeftOfWindow', () => {
  it('is true for a rect entirely above or left of the window', () => {
    expect(liesAboveOrLeftOfWindow({ x: -9999, y: -9959, width: 1280, height: 760 })).toBe(true);
    expect(liesAboveOrLeftOfWindow({ x: -100, y: 10, width: 100, height: 50 })).toBe(true);
    expect(liesAboveOrLeftOfWindow({ x: 10, y: -50, width: 100, height: 50 })).toBe(true);
  });

  it('is false for a rect that reaches into the window, even partly', () => {
    expect(liesAboveOrLeftOfWindow({ x: 10, y: 10, width: 100, height: 50 })).toBe(false);
    expect(liesAboveOrLeftOfWindow({ x: -5, y: -10, width: 100, height: 100 })).toBe(false);
  });

  it('is false past the right or bottom edge, which clampBounds already sizes to zero', () => {
    expect(liesAboveOrLeftOfWindow({ x: 5000, y: 10, width: 100, height: 50 })).toBe(false);
    expect(liesAboveOrLeftOfWindow({ x: 10, y: 5000, width: 100, height: 50 })).toBe(false);
  });
});

describe('BrowserSessionService view placement', () => {
  type FakeWindow = InstanceType<typeof BrowserWindow> & {
    contentView: { children: unknown[] };
    destroy(): void;
  };
  type FakeView = { bounds: Rect | null };

  const offscreen: Rect = { x: -9999, y: -9959, width: 1280, height: 760 };
  const onscreen: Rect = { x: 100, y: 50, width: 400, height: 300 };

  const service = (): BrowserSessionService => BrowserSessionService.getInstance();
  const newWindow = (): FakeWindow => new BrowserWindow() as unknown as FakeWindow;
  const allWindows = (): FakeWindow[] => fakes.createdWindows as FakeWindow[];
  const holdersOf = (view: unknown): FakeWindow[] =>
    allWindows().filter((w) => !w.isDestroyed() && w.contentView.children.includes(view));
  const liveHiddenHosts = (owners: FakeWindow[]): FakeWindow[] =>
    allWindows().filter((w) => !owners.includes(w) && !w.isDestroyed());

  const createEditorSession = (sessionId: string): FakeView => {
    service().createSession({ sessionId, url: 'about:blank' });
    return fakes.createdViews[fakes.createdViews.length - 1] as FakeView;
  };

  afterEach(() => {
    BrowserSessionService.__resetForTests();
    for (const w of allWindows()) w.destroy();
    fakes.createdWindows.length = 0;
    fakes.createdViews.length = 0;
  });

  it('moves a view whose placeholder is entirely off screen into the hidden host instead of the window corner', () => {
    const owner = newWindow();
    const view = createEditorSession('hidden-editor');

    service().attachToWindow('hidden-editor', owner, offscreen);

    expect(owner.contentView.children).not.toContain(view);
    const hosts = liveHiddenHosts([owner]);
    expect(hosts).toHaveLength(1);
    expect(holdersOf(view)).toEqual(hosts);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 760 });
  });

  it('keeps one hidden host and one parent across repeated off-screen bounds', () => {
    const owner = newWindow();
    const view = createEditorSession('hidden-editor');
    service().attachToWindow('hidden-editor', owner, offscreen);
    service().setBounds('hidden-editor', { ...offscreen, width: 1200 });
    service().setBounds('hidden-editor', offscreen);

    expect(liveHiddenHosts([owner])).toHaveLength(1);
    expect(holdersOf(view)).toHaveLength(1);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1280, height: 760 });
  });

  it('parks a shown view when its placeholder moves off screen, and grows the hidden host to fit it', () => {
    const owner = newWindow();
    const view = createEditorSession('hidden-editor');
    service().attachToWindow('hidden-editor', owner, onscreen);
    expect(holdersOf(view)).toEqual([owner]);

    service().setBounds('hidden-editor', { x: -9999, y: -9999, width: 1600, height: 1000 });

    const [host] = liveHiddenHosts([owner]);
    expect(holdersOf(view)).toEqual([host]);
    expect(host.getContentSize()).toEqual([1600, 1000]);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1600, height: 1000 });
  });

  it('returns a parked view to its window when the hidden host was closed under it', () => {
    const owner = newWindow();
    const view = createEditorSession('hidden-editor');
    service().attachToWindow('hidden-editor', owner, offscreen);
    const [host] = liveHiddenHosts([owner]);

    host.destroy();
    service().setBounds('hidden-editor', onscreen);

    expect(holdersOf(view)).toEqual([owner]);
    expect(view.bounds).toEqual(onscreen);
  });

  it('returns the view to its window once the placeholder is on screen, and closes the unused hidden host', () => {
    const owner = newWindow();
    const view = createEditorSession('hidden-editor');
    service().attachToWindow('hidden-editor', owner, offscreen);

    service().setBounds('hidden-editor', onscreen);

    expect(holdersOf(view)).toEqual([owner]);
    expect(view.bounds).toEqual(onscreen);
    expect(liveHiddenHosts([owner])).toHaveLength(0);
  });

  it('leaves a partly visible placeholder in its window', () => {
    const owner = newWindow();
    const view = createEditorSession('scrolled-editor');

    service().attachToWindow('scrolled-editor', owner, { x: -5, y: -10, width: 100, height: 100 });

    expect(holdersOf(view)).toEqual([owner]);
    expect(liveHiddenHosts([owner])).toHaveLength(0);
  });

  it('detaching or destroying a parked session takes its view out of the hidden host and closes the host', () => {
    const owner = newWindow();
    const detached = createEditorSession('detached');
    service().attachToWindow('detached', owner, offscreen);
    service().detachFromWindow('detached');

    expect(holdersOf(detached)).toEqual([]);
    expect(liveHiddenHosts([owner])).toHaveLength(0);

    const destroyed = createEditorSession('destroyed');
    service().attachToWindow('destroyed', owner, offscreen);
    service().destroySession('destroyed');

    expect(holdersOf(destroyed)).toEqual([]);
    expect(liveHiddenHosts([owner])).toHaveLength(0);
  });

  it('keeps the hidden host while a headless session still renders in it', () => {
    const owner = newWindow();
    service().createSession({ sessionId: 'agent', url: 'about:blank', headless: true });
    const [host] = liveHiddenHosts([owner]);
    const view = createEditorSession('hidden-editor');

    service().attachToWindow('hidden-editor', owner, offscreen);
    expect(holdersOf(view)).toEqual([host]);

    service().setBounds('hidden-editor', onscreen);
    expect(holdersOf(view)).toEqual([owner]);
    expect(host.isDestroyed()).toBe(false);

    service().destroySession('agent');
    expect(host.isDestroyed()).toBe(true);
  });

  it('moves a parked view to the window it is re-attached to', () => {
    const first = newWindow();
    const second = newWindow();
    const view = createEditorSession('moved');
    service().attachToWindow('moved', first, offscreen);

    service().attachToWindow('moved', second, onscreen);

    expect(holdersOf(view)).toEqual([second]);
    expect(liveHiddenHosts([first, second])).toHaveLength(0);
    // The first window no longer owns the session, so closing it leaves the session alive.
    first.destroy();
    expect(service().hasSession('moved')).toBe(true);
  });

  it('destroys a parked session when its owning window closes, and closes the hidden host', () => {
    const owner = newWindow();
    const view = createEditorSession('hidden-editor');
    service().attachToWindow('hidden-editor', owner, offscreen);

    owner.destroy();

    expect(service().hasSession('hidden-editor')).toBe(false);
    expect(holdersOf(view)).toEqual([]);
    expect(liveHiddenHosts([owner])).toHaveLength(0);
  });
});

describe('isAllowedBrowserUrl', () => {
  it('accepts http and https', () => {
    expect(isAllowedBrowserUrl('http://example.com')).toBe(true);
    expect(isAllowedBrowserUrl('https://example.com/path?q=1')).toBe(true);
  });

  it('accepts nim-preview', () => {
    expect(isAllowedBrowserUrl('nim-preview://workspace/abc/index.html')).toBe(true);
  });

  it('accepts about:blank', () => {
    expect(isAllowedBrowserUrl('about:blank')).toBe(true);
  });

  it('rejects file://', () => {
    expect(isAllowedBrowserUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects javascript:', () => {
    expect(isAllowedBrowserUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects data:', () => {
    expect(isAllowedBrowserUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedBrowserUrl('not a url')).toBe(false);
    expect(isAllowedBrowserUrl('')).toBe(false);
  });

  it('rejects non-strings', () => {
    // @ts-expect-error -- exercising defensive runtime check
    expect(isAllowedBrowserUrl(null)).toBe(false);
    // @ts-expect-error
    expect(isAllowedBrowserUrl(undefined)).toBe(false);
  });
});

describe('selectIdleHeadlessSessions', () => {
  const TTL = 5 * 60 * 1000;
  const NOW = 1_000_000_000;

  it('reaps a headless session idle past the TTL', () => {
    expect(
      selectIdleHeadlessSessions(
        [{ sessionId: 'agent-preview:1', headless: true, lastUsedAt: NOW - TTL - 1 }],
        NOW,
        TTL,
      ),
    ).toEqual(['agent-preview:1']);
  });

  it('reaps exactly at the TTL boundary', () => {
    expect(
      selectIdleHeadlessSessions(
        [{ sessionId: 'agent-preview:1', headless: true, lastUsedAt: NOW - TTL }],
        NOW,
        TTL,
      ),
    ).toEqual(['agent-preview:1']);
  });

  it('spares a headless session used within the TTL', () => {
    expect(
      selectIdleHeadlessSessions(
        [{ sessionId: 'agent-preview:1', headless: true, lastUsedAt: NOW - TTL + 1 }],
        NOW,
        TTL,
      ),
    ).toEqual([]);
  });

  it('never reaps editor-backed sessions, however old', () => {
    expect(
      selectIdleHeadlessSessions(
        [{ sessionId: 'browser-virtual:tab-1', headless: false, lastUsedAt: 0 }],
        NOW,
        TTL,
      ),
    ).toEqual([]);
  });

  it('reaps only the idle headless sessions from a mixed set', () => {
    const candidates = [
      { sessionId: 'browser-virtual:tab-1', headless: false, lastUsedAt: 0 },
      { sessionId: 'agent-preview:stale', headless: true, lastUsedAt: NOW - TTL * 3 },
      { sessionId: 'agent-preview:active', headless: true, lastUsedAt: NOW - 1000 },
    ];
    expect(selectIdleHeadlessSessions(candidates, NOW, TTL)).toEqual(['agent-preview:stale']);
  });

  it('returns nothing for an empty session set', () => {
    expect(selectIdleHeadlessSessions([], NOW, TTL)).toEqual([]);
  });
});

describe('resolveBrowserPartitionName', () => {
  it('uses an in-memory preview partition by default', () => {
    expect(resolveBrowserPartitionName()).toBe('browser-preview');
  });

  it('keeps plain partition names in-memory', () => {
    expect(resolveBrowserPartitionName('session-doc')).toBe('browser-session-doc');
  });

  it('preserves explicit persist: partitions', () => {
    expect(resolveBrowserPartitionName('persist:customer-a')).toBe('persist:customer-a');
  });
});

describe('keyEventsForText', () => {
  it('sends keyDown with text and keyUp per character', () => {
    expect(keyEventsForText('ab')).toEqual([
      { type: 'keyDown', key: 'a', text: 'a', unmodifiedText: 'a' },
      { type: 'keyUp', key: 'a' },
      { type: 'keyDown', key: 'b', text: 'b', unmodifiedText: 'b' },
      { type: 'keyUp', key: 'b' },
    ]);
  });

  it('turns \n and \r\n into a single Enter', () => {
    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    const expected = [
      { type: 'keyDown', key: 'x', text: 'x', unmodifiedText: 'x' },
      { type: 'keyUp', key: 'x' },
      { type: 'keyDown', ...enter, text: '\r', unmodifiedText: '\r' },
      { type: 'keyUp', ...enter },
    ];
    expect(keyEventsForText('x\n')).toEqual(expected);
    expect(keyEventsForText('x\r\n')).toEqual(expected);
  });

  it('keeps characters outside the BMP whole', () => {
    expect(keyEventsForText('😀')[0]).toEqual({ type: 'keyDown', key: '😀', text: '😀', unmodifiedText: '😀' });
  });

  it('returns nothing for empty text', () => {
    expect(keyEventsForText('')).toEqual([]);
  });
});

describe('clearEventsFor', () => {
  it('uses Cmd+A with editing commands on macOS', () => {
    const events = clearEventsFor('darwin');
    expect(events[0]).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 4, commands: ['selectAll'] });
    expect(events[2]).toMatchObject({ type: 'rawKeyDown', key: 'Delete', commands: ['deleteForward'] });
  });

  it('uses Ctrl+A without commands elsewhere', () => {
    const events = clearEventsFor('win32');
    expect(events[0]).toMatchObject({ type: 'rawKeyDown', key: 'a', modifiers: 2 });
    expect(events.some((e) => 'commands' in e)).toBe(false);
  });
});

describe('clickEvents', () => {
  it('moves, presses and releases the left button at the point', () => {
    expect(clickEvents(10, 20)).toEqual([
      { type: 'mouseMoved', x: 10, y: 20 },
      { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 10, y: 20, button: 'left', buttons: 0, clickCount: 1 },
    ]);
  });
});

describe('BrowserSessionService agent input routing', () => {
  function fakeWebContents(opts: { attachThrows?: boolean; attached?: boolean } = {}) {
    let attached = opts.attached ?? false;
    const dbg = {
      isAttached: vi.fn(() => attached),
      attach: vi.fn(() => {
        if (opts.attachThrows) throw new Error('Another debugger is already attached');
        attached = true;
      }),
      detach: vi.fn(() => {
        attached = false;
      }),
      sendCommand: vi.fn(async () => ({})),
    };
    return {
      debugger: dbg,
      sendInputEvent: vi.fn(),
      executeJavaScript: vi.fn(async () => true),
      close: vi.fn(),
    };
  }

  function serviceWith(entries: Record<string, ReturnType<typeof fakeWebContents>>) {
    const service = BrowserSessionService.getInstance();
    const sessions = (service as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.clear();
    for (const [sessionId, wc] of Object.entries(entries)) {
      sessions.set(sessionId, {
        sessionId,
        partitionName: 'browser-default',
        view: { webContents: wc },
        hostWindow: null,
        bounds: null,
        requestedBounds: null,
        state: {},
        headless: false,
        lastUsedAt: Date.now(),
      });
    }
    return service;
  }

  it('types through the target session debugger with focus emulation, never another session', async () => {
    const target = fakeWebContents();
    const other = fakeWebContents();
    const service = serviceWith({ a: target, b: other });

    await service.type('a', { text: 'hi' });

    const calls = target.debugger.sendCommand.mock.calls as unknown as [string, unknown][];
    expect(calls[0]).toEqual(['Emulation.setFocusEmulationEnabled', { enabled: true }]);
    expect(calls.slice(1)).toEqual(keyEventsForText('hi').map((e) => ['Input.dispatchKeyEvent', e]));
    expect(target.sendInputEvent).not.toHaveBeenCalled();
    expect(other.debugger.attach).not.toHaveBeenCalled();
    expect(other.debugger.sendCommand).not.toHaveBeenCalled();
    expect(other.sendInputEvent).not.toHaveBeenCalled();
  });

  it('reuses an already-attached debugger without attaching again', async () => {
    const wc = fakeWebContents({ attached: true });
    const service = serviceWith({ a: wc });

    await service.click('a', { x: 3, y: 4 });

    expect(wc.debugger.attach).not.toHaveBeenCalled();
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', clickEvents(3, 4)[1]);
  });

  it('falls back to sendInputEvent when the debugger cannot attach', async () => {
    const wc = fakeWebContents({ attachThrows: true });
    const service = serviceWith({ a: wc });

    await service.type('a', { text: 'ok' });

    expect(wc.debugger.sendCommand).not.toHaveBeenCalled();
    expect(wc.sendInputEvent).toHaveBeenCalledWith({ type: 'char', keyCode: 'o' });
    expect(wc.sendInputEvent).toHaveBeenCalledWith({ type: 'char', keyCode: 'k' });
  });

  it('detaches the debugger when the session is destroyed', async () => {
    const wc = fakeWebContents();
    const service = serviceWith({ a: wc });

    await service.type('a', { text: 'x' });
    service.destroySession('a');

    expect(wc.debugger.detach).toHaveBeenCalledTimes(1);
    expect(wc.close).toHaveBeenCalledTimes(1);
  });
});
