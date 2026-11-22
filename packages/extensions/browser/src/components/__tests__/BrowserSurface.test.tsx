import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserSurface } from '../BrowserSurface';
import { attachBrowserSession, detachBrowserSession } from '../../browserClient';

vi.mock('../../browserClient', () => ({
  attachBrowserSession: vi.fn(),
  detachBrowserSession: vi.fn().mockResolvedValue(undefined),
  setBrowserSessionBounds: vi.fn().mockResolvedValue(undefined),
}));

let frame: FrameRequestCallback;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 40, 640, 480));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('BrowserSurface attachment lifecycle', () => {
  it.each(['unmount', 'hide'] as const)('detaches when %s happens before the attach reply', async (action) => {
    let resolveAttach!: () => void;
    vi.mocked(attachBrowserSession).mockReturnValue(new Promise<void>((resolve) => {
      resolveAttach = resolve;
    }));
    const view = render(<BrowserSurface sessionId="preview" visible />);
    act(() => frame(0));
    expect(attachBrowserSession).toHaveBeenCalledOnce();

    if (action === 'unmount') view.unmount();
    else view.rerender(<BrowserSurface sessionId="preview" visible={false} />);
    await act(async () => resolveAttach());

    expect(detachBrowserSession).toHaveBeenCalledWith('preview');
  });

  it('keeps a new mount attached when the old attach reply arrives late', async () => {
    let resolveOld!: () => void;
    vi.mocked(attachBrowserSession)
      .mockReturnValueOnce(new Promise<void>((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(undefined);
    const view = render(<BrowserSurface sessionId="preview" visible />);
    act(() => frame(0));
    view.rerender(<BrowserSurface sessionId="preview" visible={false} />);
    view.rerender(<BrowserSurface sessionId="preview" visible />);
    await act(async () => frame(0));
    expect(attachBrowserSession).toHaveBeenCalledTimes(2);
    expect(detachBrowserSession).toHaveBeenCalledTimes(1);
    await act(async () => resolveOld());
    expect(detachBrowserSession).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(detachBrowserSession).toHaveBeenCalledTimes(2);
  });

  it('reports a placeholder inside the hidden-editor container as off screen, even while it is laid out on screen', async () => {
    vi.mocked(attachBrowserSession).mockResolvedValue(undefined);
    const shown = render(<BrowserSurface sessionId="shown" visible />);
    await act(async () => frame(0));
    const hiddenEditors = document.createElement('div');
    hiddenEditors.id = 'hidden-editors';
    document.body.appendChild(hiddenEditors);
    const hidden = render(<BrowserSurface sessionId="hidden" visible />, { container: hiddenEditors });
    await act(async () => frame(0));

    expect(attachBrowserSession).toHaveBeenCalledWith('shown', { x: 20, y: 40, width: 640, height: 480 });
    expect(attachBrowserSession).toHaveBeenCalledWith('hidden', { x: -640, y: -480, width: 640, height: 480 });
    shown.unmount();
    hidden.unmount();
    hiddenEditors.remove();
  });

  it('retries a rejected attach at the same bounds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(attachBrowserSession)
      .mockRejectedValueOnce(new Error('attach failed'))
      .mockResolvedValue(undefined);
    const view = render(<BrowserSurface sessionId="preview" visible />);
    await act(async () => frame(0));
    await act(async () => frame(0));
    expect(attachBrowserSession).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(detachBrowserSession).toHaveBeenCalledWith('preview');
  });
});
