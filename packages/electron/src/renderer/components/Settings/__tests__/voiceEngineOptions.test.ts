// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import recordings from '../../../assets/voice-previews/gpt-live-1/manifest.json';
import { previewEligibility, resolveVoiceForEngine, voicesForEngine } from '../voiceEngineOptions';
import { realtimeModelForEngine, resolveVoiceEngine } from '../../../../main/services/voice/VoiceModeSettingsHandler';

describe('voice lists', () => {
  it('corrects a voice the target engine does not accept', () => {
    expect(resolveVoiceForEngine('live', 'marin')).toBe('marin');
    expect(resolveVoiceForEngine('live', 'not-a-voice')).toBe(voicesForEngine('live')[0].id);
    expect(resolveVoiceForEngine('realtime', undefined)).toBe(voicesForEngine('realtime')[0].id);
  });
});

describe('previewEligibility', () => {
  it('ships intact recordings of the selected model and voice', () => {
    for (const voice of voicesForEngine('live')) {
      const recording = recordings.recordings.find(sample => sample.voice === voice.id);
      expect(recording?.model).toBe('gpt-live-1');
      const file = new URL(`../../../assets/voice-previews/gpt-live-1/${voice.id}.mp3`, import.meta.url);
      expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(recording?.sha256);
    }
  });

  it('previews a voice the speech endpoint has, with no caveat', () => {
    expect(previewEligibility('realtime', 'alloy')).toEqual({ canPreview: true, approximate: false, note: '' });
  });

  it('labels a stand-in as a stand-in rather than previewing it silently', () => {
    const result = previewEligibility('realtime', 'cedar');
    expect(result.canPreview).toBe(true);
    expect(result.approximate).toBe(true);
    expect(result.note).not.toBe('');
  });

  it('offers an actual bundled recording for every Live voice', () => {
    for (const voice of voicesForEngine('live')) {
      expect(previewEligibility('live', voice.id)).toEqual({ canPreview: true, approximate: false, note: '' });
    }
  });

  it('refuses to preview a voice with no legitimate equivalent', () => {
    const result = previewEligibility('live', 'some-future-live-voice');
    expect(result.canPreview).toBe(false);
    expect(result.note).not.toBe('');
  });
});

describe('engine selection', () => {
  it('reports the fallback instead of silently downgrading', () => {
    expect(resolveVoiceEngine('live', true)).toEqual({ engine: 'live', reason: '' });
    const fallback = resolveVoiceEngine('live', false);
    expect(fallback.engine).toBe('realtime');
    expect(fallback.fallbackFrom).toBe('live');
    expect(fallback.reason).not.toBe('');
  });

  it('defaults to Live while preserving an explicit Realtime selection', () => {
    expect(resolveVoiceEngine('realtime', true).engine).toBe('realtime');
    expect(resolveVoiceEngine(undefined, true).engine).toBe('live');
    expect(resolveVoiceEngine('gpt-realtime-2', true).engine).toBe('live');
  });

  it('never hands a Realtime model string to the Live path', () => {
    expect(realtimeModelForEngine('realtime', 'gpt-realtime')).toBe('gpt-realtime');
    expect(realtimeModelForEngine('realtime', undefined)).toBe('gpt-realtime-2');
    expect(realtimeModelForEngine('live', 'gpt-realtime-2')).toBeUndefined();
  });
});
