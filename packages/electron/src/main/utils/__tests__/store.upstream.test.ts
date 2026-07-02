/**
 * Tests for the custom Claude API upstream URL validator (loopback guard).
 *
 * The Claude CLI's requests carry the user's subscription OAuth token + full
 * prompt context, so a custom upstream MUST be loopback-bound — a remote host
 * would leak both. These cases pin that guard.
 */

import { describe, expect, it } from 'vitest';
import { isValidClaudeCodeApiUpstreamUrl } from '../store';

describe('isValidClaudeCodeApiUpstreamUrl', () => {
  it('accepts loopback http(s) URLs, with or without a base path/port', () => {
    expect(isValidClaudeCodeApiUpstreamUrl('http://127.0.0.1:8787/anthropic')).toBe(true);
    expect(isValidClaudeCodeApiUpstreamUrl('http://localhost:8787')).toBe(true);
    expect(isValidClaudeCodeApiUpstreamUrl('https://127.0.0.1/gateway/anthropic')).toBe(true);
    expect(isValidClaudeCodeApiUpstreamUrl('http://[::1]:9000')).toBe(true);
    expect(isValidClaudeCodeApiUpstreamUrl('http://127.0.0.2:1234')).toBe(true);
  });

  it('rejects non-loopback hosts (would leak the OAuth token off-box)', () => {
    expect(isValidClaudeCodeApiUpstreamUrl('https://api.anthropic.com')).toBe(false);
    expect(isValidClaudeCodeApiUpstreamUrl('http://192.168.1.10:8787')).toBe(false);
    expect(isValidClaudeCodeApiUpstreamUrl('http://10.0.0.5')).toBe(false);
    expect(isValidClaudeCodeApiUpstreamUrl('http://evil.example.com/anthropic')).toBe(false);
    // Hostname that merely starts with 127 but isn't loopback.
    expect(isValidClaudeCodeApiUpstreamUrl('http://127.0.0.1.evil.com')).toBe(false);
  });

  it('rejects non-http(s) protocols and unparseable input', () => {
    expect(isValidClaudeCodeApiUpstreamUrl('ftp://127.0.0.1')).toBe(false);
    expect(isValidClaudeCodeApiUpstreamUrl('file:///etc/passwd')).toBe(false);
    expect(isValidClaudeCodeApiUpstreamUrl('not a url')).toBe(false);
    expect(isValidClaudeCodeApiUpstreamUrl('')).toBe(false);
  });
});
