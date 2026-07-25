/**
 * Tests for detectStreamingIntent's bounded (head-only) marker scan.
 *
 * The caller (aiApi) invokes this on the full, growing accumulated content on
 * every stream chunk. Scanning the whole string each time is O(n^2) over a
 * response and froze the renderer on long turns. A STREAM_EDIT / @stream-to-editor
 * directive only appears at the start, so we scan the head; the clean-content
 * slice is still derived from the full content.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: {
    protocol: { info: () => {}, warn: () => {} },
    streaming: { info: () => {} },
  },
}));

import { detectStreamingIntent } from '../aiStreamProtocol';

describe('detectStreamingIntent (bounded head scan)', () => {
  it('returns not-streaming for ordinary content', () => {
    const r = detectStreamingIntent('hello, this is a normal response');
    expect(r.isStreaming).toBe(false);
    expect(r.cleanContent).toBe('hello, this is a normal response');
  });

  it('detects a STREAM_EDIT marker at the start and returns the full clean content', () => {
    const body = 'x'.repeat(50000); // clean content far larger than the scan window
    const r = detectStreamingIntent(`<!-- STREAM_EDIT: {"position":"cursor","mode":"after"} -->\n${body}`);
    expect(r.isStreaming).toBe(true);
    expect(r.streamConfig).toEqual({ position: 'cursor', mode: 'after' });
    // cleanContent is derived from the FULL content, not just the scanned head
    expect(r.cleanContent).toBe(body);
    expect(r.cleanContent.length).toBe(50000);
  });

  it('detects an @stream-to-editor marker at the start', () => {
    const r = detectStreamingIntent('@stream-to-editor cursor after\nrest of body');
    expect(r.isStreaming).toBe(true);
    expect(r.streamConfig?.position).toBe('cursor');
  });

  it('does not scan the whole body when there is no marker (bounded work on huge content)', () => {
    const huge = 'y'.repeat(2_000_000);
    const before = Date.now();
    const r = detectStreamingIntent(huge);
    const elapsed = Date.now() - before;
    expect(r.isStreaming).toBe(false);
    expect(r.cleanContent).toBe(huge);
    // head-only scan should be effectively instant even for a 2 MB body
    expect(elapsed).toBeLessThan(50);
  });
});
