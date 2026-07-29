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
  isAllowedBrowserUrl,
  resolveBrowserPartitionName,
  selectIdleHeadlessSessions,
} from '../BrowserSessionService';

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
