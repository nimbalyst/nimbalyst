// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConsoleLinkRouter } from '../consoleLinkRouter';

const DOC = 'https://console.nimbalyst.com/org/o/project/p/document/d';

function fakeWindow() {
  return { send: vi.fn(), isDestroyed: () => false };
}

describe('console link router', () => {
  let openExternal: ReturnType<typeof vi.fn<(url: string) => void>>;
  let router: ReturnType<typeof createConsoleLinkRouter>;

  beforeEach(() => {
    vi.useFakeTimers();
    openExternal = vi.fn<(url: string) => void>();
    router = createConsoleLinkRouter({ openExternal, ackTimeoutMs: 1000 });
  });
  afterEach(() => vi.useRealTimers());

  it('hands a console link to the window instead of the browser', () => {
    const win = fakeWindow();
    expect(router.route(DOC, win)).toBe(true);
    const [channel, payload] = win.send.mock.calls[0];
    expect(channel).toBe('console-link:open');
    expect(payload).toMatchObject({ url: DOC, fromDeepLink: false });
    router.settle(payload.requestId, true);
    vi.runAllTimers();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens the browser when the window cannot open it or never answers', () => {
    const win = fakeWindow();
    router.route(DOC, win);
    router.settle(win.send.mock.calls[0][1].requestId, false);
    expect(openExternal).toHaveBeenCalledWith(DOC);

    router.route(DOC, win);
    vi.advanceTimersByTime(1000);
    expect(openExternal).toHaveBeenCalledTimes(2);
    // A late answer after the timeout changes nothing.
    router.settle(win.send.mock.calls[1][1].requestId, true);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('never sends a link that came from the console back to the browser', () => {
    const win = fakeWindow();
    expect(router.routeDeepLink('nimbalyst://console/app/cite/s/prompt/k', win)).toBe(true);
    expect(win.send.mock.calls[0][1]).toMatchObject({ url: 'https://console.nimbalyst.com/app/cite/s/prompt/k', fromDeepLink: true });
    vi.advanceTimersByTime(1000);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('leaves every other URL alone', () => {
    const win = fakeWindow();
    expect(router.route('https://example.com/', win)).toBe(false);
    expect(router.route('https://console.nimbalyst.com/org/o/admin', win)).toBe(false);
    expect(router.routeDeepLink('nimbalyst://tracker/x', win)).toBe(false);
    expect(win.send).not.toHaveBeenCalled();
  });

  it('opens the browser right away when there is no window to ask', () => {
    expect(router.route(DOC, null)).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(DOC);
  });
});
