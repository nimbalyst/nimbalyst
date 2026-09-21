import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureNativeElement, visibleCaptureRect } from '../nativeScreenshot';

function element(
  rect: { x: number; y: number; width: number; height: number },
  tag = 'div'
) {
  const el = document.createElement(tag);
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON() {},
  });
  document.body.append(el);
  return el;
}
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('native screenshot bounds', () => {
  it('clips to the window and scrolling ancestors before capturing pixels', async () => {
    const parent = element({ x: 20, y: 30, width: 150, height: 100 });
    parent.style.overflowX = 'hidden';
    parent.style.overflowY = 'auto';
    const child = element({ x: 10, y: 10, width: 300, height: 300 });
    parent.append(child);
    const invoke = vi
      .fn()
      .mockResolvedValue({ success: true, imageBase64: 'png' });
    vi.stubGlobal('electronAPI', { invoke });
    expect(await captureNativeElement(child)).toBe('png');
    expect(invoke).toHaveBeenCalledWith('offscreen-editor:native-capture', {
      rect: { x: 20, y: 30, width: 150, height: 100 },
    });
  });

  it('captures an iframe without accessing or cloning its document', async () => {
    const iframe = element({ x: 25, y: 35, width: 200, height: 120 }, 'iframe');
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      overflowX: 'visible',
      overflowY: 'visible',
    } as CSSStyleDeclaration);
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        throw new Error('cross-origin');
      },
    });
    vi.stubGlobal('electronAPI', {
      invoke: vi
        .fn()
        .mockResolvedValue({ success: true, imageBase64: 'iframe-png' }),
    });
    expect(await captureNativeElement(iframe)).toBe('iframe-png');
  });

  it('rejects hidden, detached, and off-viewport targets', () => {
    const el = element({ x: 10, y: 10, width: 100, height: 100 });
    el.style.visibility = 'hidden';
    expect(() => visibleCaptureRect(el)).toThrow('hidden');
    el.remove();
    expect(() => visibleCaptureRect(el)).toThrow('mounted');
    expect(() =>
      visibleCaptureRect(element({ x: -200, y: 0, width: 100, height: 100 }))
    ).toThrow('visible area');
  });

  it('surfaces native failures and empty images', async () => {
    const el = element({ x: 0, y: 0, width: 100, height: 100 });
    vi.stubGlobal('electronAPI', {
      invoke: vi
        .fn()
        .mockResolvedValue({ success: false, error: 'window closed' }),
    });
    await expect(captureNativeElement(el)).rejects.toThrow('window closed');
  });
});
