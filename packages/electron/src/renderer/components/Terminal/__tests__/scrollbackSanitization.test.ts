import { describe, it, expect, vi } from 'vitest';
import { sanitizeScrollback } from '../scrollbackSanitization';

describe('sanitizeScrollback', () => {
  // Regression: a single stray NUL byte used to discard the ENTIRE scrollback,
  // producing the "could not be restored cleanly" banner on nearly every
  // terminal restore. It should now strip the NUL and keep the surrounding text.
  it('strips a stray NUL byte instead of discarding the whole buffer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = sanitizeScrollback('hello\x00world');
    expect(result).toBe('helloworld');
    warn.mockRestore();
  });

  it('returns content unchanged when there is no corruption', () => {
    const clean = 'normal terminal output\r\n$ ls -la\r\n';
    expect(sanitizeScrollback(clean)).toBe(clean);
  });

  it('preserves common control characters (tab, newline, CR, ESC sequences)', () => {
    const input = '\x1b[32mgreen\x1b[0m\ttabbed\r\nline';
    expect(sanitizeScrollback(input)).toBe(input);
  });

  it('strips a NUL-heavy buffer down to its valid text (NULs are not corruption)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A NUL-heavy stream (e.g. `cat /dev/zero`) carries no real corruption —
    // stripping the NULs leaves whatever valid text surrounds them.
    const result = sanitizeScrollback('\x00'.repeat(1000) + 'a'.repeat(10));
    expect(result).toBe('a'.repeat(10));
    warn.mockRestore();
  });

  it('keeps a large valid buffer that contains only a handful of NUL bytes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const big = 'x'.repeat(100_000) + '\x00' + 'y'.repeat(100_000);
    const result = sanitizeScrollback(big);
    expect(result).not.toBeNull();
    expect(result).not.toContain('\x00');
    expect(result?.length).toBe(200_000);
    warn.mockRestore();
  });

  it('discards buffers with a high density of suspicious control characters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // \x01 (SOH) is a suspicious control char; fill past the 0.5% threshold
    const corrupt = '\x01'.repeat(50) + 'a'.repeat(100);
    expect(sanitizeScrollback(corrupt)).toBeNull();
    warn.mockRestore();
  });

  it('handles an empty string without throwing', () => {
    expect(sanitizeScrollback('')).toBe('');
  });
});
