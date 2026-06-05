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
