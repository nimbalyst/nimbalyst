import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// RealtimeAPIClient imports electron (ipcMain), ws, and AnalyticsService at the
// top level. Mock them so the client can be constructed in a plain node test
// without opening a socket or pulling in posthog/electron app side effects.
vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), once: vi.fn(), removeListener: vi.fn(), removeAllListeners: vi.fn() },
}));
vi.mock('ws', () => ({ default: class {} }));
vi.mock('../../analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

import { RealtimeAPIClient } from '../RealtimeAPIClient';

function makeClient(): RealtimeAPIClient {
  return new RealtimeAPIClient('test-key', 'coding-session', '/workspace', {} as any);
}

function attachFakeSocket(client: RealtimeAPIClient): any[] {
  const sent: any[] = [];
  (client as any).ws = { send: (s: string) => sent.push(JSON.parse(s)) };
  (client as any).connected = true;
  return sent;
}

/**
 * NIM-1594: the renderer's listen window is held open by a speech-started
 * signal that must fire for EVERY VAD trigger, independent of the barge-in
 * interrupt decision. Before this, echo-suspect triggers whose playback
 * drained inside the probation window produced NO renderer signal at all,
 * so the listen window could expire mid-utterance.
 */
describe('RealtimeAPIClient speech signals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onSpeechStarted AND onInterruption for a genuine trigger (nothing playing)', () => {
    const client = makeClient();
    attachFakeSocket(client);
    const speechStarted = vi.fn();
    const interruption = vi.fn();
    client.setOnSpeechStarted(speechStarted);
    client.setOnInterruption(interruption);

    (client as any).handleServerEvent({ type: 'input_audio_buffer.speech_started' });

    expect(speechStarted).toHaveBeenCalledTimes(1);
    expect(interruption).toHaveBeenCalledTimes(1);
  });

  it('fires onSpeechStarted immediately for an echo-suspect trigger even though the interrupt is deferred', () => {
    const client = makeClient();
    attachFakeSocket(client);
    const speechStarted = vi.fn();
    const interruption = vi.fn();
    client.setOnSpeechStarted(speechStarted);
    client.setOnInterruption(interruption);

    // Agent audio audibly playing -> the barge-in policy defers the interrupt.
    (client as any).playbackActive = true;
    (client as any).bargeInPolicy.notePlaybackStarted();

    (client as any).handleServerEvent({ type: 'input_audio_buffer.speech_started' });

    expect(speechStarted).toHaveBeenCalledTimes(1);
    expect(interruption).not.toHaveBeenCalled();

    // Playback drains inside the probation window -> interrupt is suppressed
    // entirely, but the renderer already got the speech-started signal.
    (client as any).playbackActive = false;
    vi.advanceTimersByTime(600);
    expect(interruption).not.toHaveBeenCalled();
    expect(speechStarted).toHaveBeenCalledTimes(1);
  });

  it('fires onSpeechStopped when the VAD reports silence', () => {
    const client = makeClient();
    attachFakeSocket(client);
    const speechStopped = vi.fn();
    client.setOnSpeechStopped(speechStopped);

    (client as any).handleServerEvent({ type: 'input_audio_buffer.speech_started' });
    (client as any).handleServerEvent({ type: 'input_audio_buffer.speech_stopped' });

    expect(speechStopped).toHaveBeenCalledTimes(1);
  });
});
