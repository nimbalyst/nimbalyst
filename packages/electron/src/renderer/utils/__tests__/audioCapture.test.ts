import { describe, expect, it } from 'vitest';
import { normalizeAudioCaptureError } from '../audioCapture';

describe('normalizeAudioCaptureError', () => {
  it('turns a getUserMedia NotFoundError into actionable microphone guidance', () => {
    const original = new DOMException('Requested device not found', 'NotFoundError');
    const normalized = normalizeAudioCaptureError(original);

    expect(normalized.message).toContain('No usable microphone was found');
    expect(normalized.message).toContain('system microphone settings');
  });

  it('preserves other Error instances', () => {
    const original = new Error('Audio context failed');

    expect(normalizeAudioCaptureError(original)).toBe(original);
  });
});
