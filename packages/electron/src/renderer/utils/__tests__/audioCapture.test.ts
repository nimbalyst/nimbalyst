// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioCapture, normalizeAudioCaptureError } from '../audioCapture';

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


afterEach(() => vi.unstubAllGlobals());

it('does not report capture ready until the audio context is running', async () => {
  let resume!: () => void;
  const resumed = new Promise<void>(resolve => { resume = resolve; });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } });
  vi.stubGlobal('AudioContext', class {
    destination = {}; state = 'suspended';
    resume = () => resumed.then(() => { this.state = 'running'; });
    close = async () => {};
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
    createScriptProcessor = () => ({ connect() {}, disconnect() {}, onaudioprocess: null });
  });
  const capture = new AudioCapture();
  const starting = capture.start(() => {});
  await Promise.resolve();
  expect(capture.isCaptureActive()).toBe(false);
  resume();
  await starting;
  expect(capture.isCaptureActive()).toBe(true);
  capture.stop();
});
