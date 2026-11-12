import WebSocket from 'ws';
import { DICTATION_SAMPLE_RATE } from '../../../shared/dictation';
import type {
  DictationEngine,
  DictationEngineCallbacks,
  DictationEngineSession,
  DictationEngineStartOptions,
  DictationEngineStartResult,
} from './DictationEngine';

/**
 * Transcription-only Realtime session: `intent=transcription` never generates
 * a response, so nothing is ever spoken or sent to a model as a prompt. This
 * is a thin dedicated client rather than RealtimeAPIClient, which is built
 * around a speaking voice agent (tools, barge-in, reconnects).
 */
const REALTIME_TRANSCRIPTION_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';
/** Supports `prompt` biasing, which we use for project vocabulary. */
const TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 8_000;
const MAX_PROMPT_LENGTH = 800;

export interface OpenAIEngineDeps {
  getApiKey(): string | undefined;
  createSocket?(url: string, apiKey: string): WebSocket;
  log(message: string): void;
}

export function buildTranscriptionPrompt(contextStrings: string[]): string | undefined {
  if (contextStrings.length === 0) return undefined;
  let prompt = 'Vocabulary: ';
  for (const [index, value] of contextStrings.entries()) {
    const piece = (index === 0 ? '' : ', ') + value;
    if (prompt.length + piece.length > MAX_PROMPT_LENGTH) break;
    prompt += piece;
  }
  return prompt;
}

/** The transcription API takes ISO-639-1 ('en'), not BCP-47 ('en-US'). */
export function toIso639(language: string | undefined): string | undefined {
  const primary = language?.split(/[-_]/)[0]?.toLowerCase();
  return primary && /^[a-z]{2}$/.test(primary) ? primary : undefined;
}

export function buildTranscriptionSessionUpdate(options: DictationEngineStartOptions) {
  const prompt = buildTranscriptionPrompt(options.contextStrings);
  const language = toIso639(options.language);
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: DICTATION_SAMPLE_RATE },
          transcription: {
            model: TRANSCRIPTION_MODEL,
            ...(prompt ? { prompt } : {}),
            ...(language ? { language } : {}),
          },
          // Server VAD splits long dictation into segments so finals arrive
          // while the user is still talking.
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600 },
          noise_reduction: { type: 'near_field' },
        },
      },
    },
  };
}

function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

export class OpenAIDictationEngine implements DictationEngine {
  readonly id = 'openai' as const;
  private sockets = new Set<WebSocket>();

  constructor(private readonly deps: OpenAIEngineDeps) {}

  isAvailable(): boolean {
    return Boolean(this.deps.getApiKey());
  }

  start(options: DictationEngineStartOptions, callbacks: DictationEngineCallbacks): Promise<DictationEngineStartResult> {
    const apiKey = this.deps.getApiKey();
    if (!apiKey) return Promise.resolve({ ok: false, reason: 'no-engine' });

    const ws = this.deps.createSocket
      ? this.deps.createSocket(REALTIME_TRANSCRIPTION_URL, apiKey)
      : new WebSocket(REALTIME_TRANSCRIPTION_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    this.sockets.add(ws);

    // item_id -> accumulated delta text, in arrival order.
    const inFlight = new Map<string, string>();
    let pendingCommit = false;
    let stopping = false;
    let started = false;
    let ended = false;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveStart: ((result: DictationEngineStartResult) => void) | null = null;

    const emitPartial = () => {
      callbacks.onEvent({ type: 'partial', text: Array.from(inFlight.values()).join(' ').trim() });
    };

    const end = () => {
      if (ended) return;
      ended = true;
      if (stopTimer) clearTimeout(stopTimer);
      this.sockets.delete(ws);
      try { ws.close(); } catch { /* already closed */ }
      if (started) callbacks.onEnded();
    };

    const finishIfDrained = () => {
      if (stopping && !pendingCommit && inFlight.size === 0) end();
    };

    const failStart = (message: string) => {
      const resolve = resolveStart;
      resolveStart = null;
      end();
      resolve?.({ ok: false, reason: 'engine-error', message });
    };

    const session: DictationEngineSession = {
      pushAudio: (base64Pcm16) => {
        if (ended || stopping || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Pcm16 }));
      },
      stop: (cancel) => {
        if (ended || stopping) return;
        stopping = true;
        if (cancel || ws.readyState !== WebSocket.OPEN) {
          end();
          return;
        }
        pendingCommit = true;
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        stopTimer = setTimeout(end, STOP_TIMEOUT_MS);
      },
    };

    const handleServerEvent = (event: Record<string, any>) => {
      switch (event.type) {
        case 'session.created':
          return;
        case 'session.updated':
        case 'transcription_session.updated':
          if (resolveStart) {
            const resolve = resolveStart;
            resolveStart = null;
            started = true;
            resolve({ ok: true, session });
            callbacks.onEvent({ type: 'ready' });
          }
          return;
        case 'input_audio_buffer.committed':
          pendingCommit = false;
          if (typeof event.item_id === 'string' && !inFlight.has(event.item_id)) inFlight.set(event.item_id, '');
          finishIfDrained();
          return;
        case 'conversation.item.input_audio_transcription.delta':
          if (typeof event.item_id === 'string' && typeof event.delta === 'string') {
            inFlight.set(event.item_id, (inFlight.get(event.item_id) ?? '') + event.delta);
            emitPartial();
          }
          return;
        case 'conversation.item.input_audio_transcription.completed': {
          inFlight.delete(event.item_id);
          const text = typeof event.transcript === 'string' ? event.transcript.trim() : '';
          if (text) callbacks.onEvent({ type: 'final', text });
          emitPartial();
          finishIfDrained();
          return;
        }
        case 'conversation.item.input_audio_transcription.failed':
          inFlight.delete(event.item_id);
          callbacks.onEvent({ type: 'error', message: event.error?.message ?? 'Transcription failed.' });
          emitPartial();
          finishIfDrained();
          return;
        case 'error': {
          const code = event.error?.code;
          // Stopping with nothing buffered (server VAD already committed it).
          if (code === 'input_audio_buffer_commit_empty') {
            pendingCommit = false;
            finishIfDrained();
            return;
          }
          const message = redact(String(event.error?.message ?? 'OpenAI transcription error'), apiKey);
          this.deps.log(`[Dictation] OpenAI error code=${code}: ${message}`);
          if (resolveStart) {
            failStart(message);
            return;
          }
          callbacks.onEvent({ type: 'error', message });
          return;
        }
      }
    };

    return new Promise<DictationEngineStartResult>((resolve) => {
      resolveStart = resolve;
      const startTimer = setTimeout(() => {
        if (resolveStart) failStart('OpenAI transcription did not start in time.');
      }, START_TIMEOUT_MS);

      ws.on('open', () => {
        ws.send(JSON.stringify(buildTranscriptionSessionUpdate(options)));
      });
      ws.on('message', (data: WebSocket.Data) => {
        let event: Record<string, any>;
        try {
          event = JSON.parse(data.toString());
        } catch {
          return;
        }
        handleServerEvent(event);
        if (!resolveStart) clearTimeout(startTimer);
      });
      ws.on('error', (error) => {
        const message = redact(String(error), apiKey);
        this.deps.log(`[Dictation] OpenAI socket error: ${message}`);
        if (resolveStart) {
          clearTimeout(startTimer);
          failStart(message);
        }
      });
      ws.on('close', (code) => {
        clearTimeout(startTimer);
        if (resolveStart) {
          failStart(`OpenAI closed the connection (${code}).`);
          return;
        }
        if (!ended && !stopping) {
          callbacks.onEvent({ type: 'error', message: `OpenAI closed the connection (${code}).` });
        }
        end();
      });
    });
  }

  dispose(): void {
    for (const ws of this.sockets) {
      try { ws.close(); } catch { /* already closed */ }
    }
    this.sockets.clear();
  }
}
