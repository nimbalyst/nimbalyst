// @vitest-environment node
/**
 * Pure-function tests for BrowserSessionService helpers.
 *
 * The service itself depends on `WebContentsView` which requires a live
 * Electron runtime, so these tests focus on the standalone helpers that drive
 * its bounds clamping and URL validation. Coverage of the IPC layer is
 * intentionally left to integration / E2E tests.
 */
import { describe, it, expect } from 'vitest';
import {
  clampBounds,
  clearEventsFor,
  clickEvents,
  isAllowedBrowserUrl,
  keyEventsForText,
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
