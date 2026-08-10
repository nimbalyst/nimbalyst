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

/**
 * The audio queue in the renderer is a flat FIFO with no notion of which
 * response a chunk belongs to. When a barge-in cancels a response, the server
 * has usually already emitted more audio deltas for it (generation runs far
 * ahead of realtime). Those late deltas used to be forwarded verbatim, land in
 * the queue the renderer just cleared, and play in front of the NEXT response's
 * audio -- two different utterances stitched together, heard as the agent's
 * voice changing partway through.
 */
describe('RealtimeAPIClient abandoned response audio', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function startResponse(client: RealtimeAPIClient, id: string): void {
    (client as any).handleServerEvent({ type: 'response.created', response: { id } });
  }

  function sendAudio(client: RealtimeAPIClient, responseId: string, delta: string): void {
    (client as any).handleServerEvent({
      type: 'response.output_audio.delta',
      response_id: responseId,
      item_id: `item-${responseId}`,
      delta,
    });
  }

  it('drops audio deltas from a response the user barged in on, and plays the next one', () => {
    const client = makeClient();
    attachFakeSocket(client);
    const audio = vi.fn();
    client.setOnAudio(audio);

    startResponse(client, 'resp_1');
    sendAudio(client, 'resp_1', 'heard');
    expect(audio).toHaveBeenCalledWith('heard');

    // User barges in -> the renderer stops playback and we cancel resp_1.
    (client as any).handleServerEvent({ type: 'input_audio_buffer.speech_started' });

    // Deltas already in flight for the cancelled response must not reach the
    // speakers -- the renderer just cleared its queue for a fresh turn.
    sendAudio(client, 'resp_1', 'stale-tail');
    expect(audio).not.toHaveBeenCalledWith('stale-tail');

    // The next response is unaffected.
    (client as any).handleServerEvent({ type: 'response.done', response: { id: 'resp_1' } });
    startResponse(client, 'resp_2');
    sendAudio(client, 'resp_2', 'fresh');
    expect(audio).toHaveBeenCalledWith('fresh');
  });

  it('suppresses the tail even when the cancel is skipped for an in-flight function call', () => {
    const client = makeClient();
    attachFakeSocket(client);
    const audio = vi.fn();
    client.setOnAudio(audio);

    startResponse(client, 'resp_1');
    // Function-call args are streaming, so cancelCurrentResponse() deliberately
    // does NOT cancel -- but the renderer still stopped playback, so the rest of
    // this response's audio must not be played on top of the next turn.
    (client as any).handleServerEvent({ type: 'response.function_call_arguments.delta' });
    (client as any).handleServerEvent({ type: 'input_audio_buffer.speech_started' });

    sendAudio(client, 'resp_1', 'stale-tail');
    expect(audio).not.toHaveBeenCalled();
  });
});

/**
 * A session.update that lands while the model is still rendering audio
 * perturbs the in-progress render (heard as the voice shifting register
 * partway through a long answer). The response-gating toggle fired on every
 * playback start, which is mid-generation for any response longer than the
 * playback lead. While a response is active the server cannot start another
 * one anyway, so the gate can wait for response.done and lose nothing.
 */
describe('RealtimeAPIClient response gating updates', () => {
  function turnDetectionUpdates(sent: any[]): any[] {
    return sent.filter((e) => e.type === 'session.update' && e.session?.audio?.input?.turn_detection);
  }

  it('defers the gating session.update until the active response is done', () => {
    const client = makeClient();
    const sent = attachFakeSocket(client);

    (client as any).handleServerEvent({ type: 'response.created', response: { id: 'resp_1' } });
    client.setPlaybackActive(true);

    expect(turnDetectionUpdates(sent)).toHaveLength(0);

    (client as any).handleServerEvent({ type: 'response.done', response: { id: 'resp_1' } });

    const updates = turnDetectionUpdates(sent);
    expect(updates).toHaveLength(1);
    expect(updates[0].session.audio.input.turn_detection.create_response).toBe(false);
  });

  it('sends nothing when playback starts and drains entirely within one response', () => {
    const client = makeClient();
    const sent = attachFakeSocket(client);

    (client as any).handleServerEvent({ type: 'response.created', response: { id: 'resp_1' } });
    client.setPlaybackActive(true);
    client.setPlaybackActive(false);
    (client as any).handleServerEvent({ type: 'response.done', response: { id: 'resp_1' } });

    expect(turnDetectionUpdates(sent)).toHaveLength(0);
  });

  it('sends the gate immediately when no response is active', () => {
    const client = makeClient();
    const sent = attachFakeSocket(client);

    client.setPlaybackActive(true);

    expect(turnDetectionUpdates(sent)).toHaveLength(1);
  });
});
