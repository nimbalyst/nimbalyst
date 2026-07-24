import { detectStreamingIntent } from './streaming';
import { startStreamingEdit, streamContent, endStreamingEdit } from './editorBridge';
import type { ProviderRequest, StreamCallbacks } from './types';
import { providers } from './providers';
import type { ProviderStreamParams } from './providers/types';
import { buildSystemPrompt } from './prompt';

async function* fetchTextStream(url: string, init: RequestInit = {}): AsyncGenerator<string, void, unknown> {
  const res = await fetch(url, init);
  if (!res.ok || !res.body) throw new Error(`AI request failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let done: boolean | undefined, value: Uint8Array | undefined;
  while (true) {
    ({ done, value } = await reader.read());
    if (done) break;
    if (value) yield decoder.decode(value, { stream: true });
  }
}

export async function sendStreamingEdit(
  req: ProviderRequest & { endpoint: string },
  opts?: { signal?: AbortSignal; callbacks?: StreamCallbacks }
): Promise<void> {
  const { prompt, document, endpoint, headers = {}, apiKey } = req;
  const body = JSON.stringify({ prompt, document });
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;

  const streamId = `stream_${Date.now()}`;
  let isStreaming = false;
  let accumulated = '';
  let outBuffer = '';

  const iter = fetchTextStream(endpoint, { method: 'POST', headers: h, body, signal: opts?.signal });
  try {
    for await (const chunk of iter) {
      if (opts?.signal?.aborted) break;
      accumulated += chunk;
      if (!isStreaming) {
        const { isStreaming: yes, streamConfig, cleanContent } = detectStreamingIntent(accumulated);
        if (yes && streamConfig) {
          isStreaming = true;
          startStreamingEdit({ id: streamId, ...streamConfig });
          if (cleanContent) {
            outBuffer += cleanContent;
            accumulated = '';
          }
        }
      } else {
        outBuffer += chunk;
      }

      // When streaming, flush buffer safely and detect end marker
      if (isStreaming && outBuffer) {
        const END_A = '<!-- STREAM_END -->';
        const END_B = '@end-stream';
        const endIdxA = outBuffer.indexOf(END_A);
        const endIdxB = outBuffer.indexOf(END_B);
        const endIdx = endIdxA >= 0 ? endIdxA : endIdxB;
        if (endIdx >= 0) {
          const before = outBuffer.slice(0, endIdx);
          if (before.trim()) {
            opts?.callbacks?.onContent?.(before);
            streamContent(streamId, before);
          }
          endStreamingEdit(streamId);
          opts?.callbacks?.onEnd?.();
          return; // Done
        }
        // Emit buffer except a small guard tail to avoid cutting an end marker
        const GUARD = 32;
        if (outBuffer.length > GUARD) {
          const emit = outBuffer.slice(0, outBuffer.length - GUARD);
          if (emit) {
            opts?.callbacks?.onContent?.(emit);
            streamContent(streamId, emit);
          }
          outBuffer = outBuffer.slice(-GUARD);
        }
      }
    }
  } finally {
    if (isStreaming) {
      // Flush any remaining buffer (without markers)
      if (outBuffer) {
        const END_A = '<!-- STREAM_END -->';
        const END_B = '@end-stream';
        const cut = outBuffer.split(END_A)[0].split(END_B)[0];
        if (cut.trim()) {
          opts?.callbacks?.onContent?.(cut);
          streamContent(streamId, cut);
        }
      }
      endStreamingEdit(streamId);
      opts?.callbacks?.onEnd?.();
    }
  }
}

function createStreamingEditPrompt(action: string, position: string, direction: string): string {
  return `<!-- STREAM_START position="${position}" direction="${direction}" -->\nPerform this action: ${action}\n`;
}

function buildGeneralSystem(): string {
  // Ask the model to decide where and how to edit; we default to after/cursor but the model
  // should include insertAtEnd or insertAfter based on the document it sees.
  return createStreamingEditPrompt('edit the document intelligently', 'cursor', 'after') +
    `\nChoose placement yourself: prefer insertAfter a matching heading when extending a section, or insertAtEnd for new sections.`;
}

export async function sendStreamingEditWithProvider(
  req: ProviderRequest & { provider: 'anthropic' | 'openai' | 'lmstudio'; history?: { role: 'user'|'assistant'; content: string }[] },
  opts?: { signal?: AbortSignal; callbacks?: StreamCallbacks }
): Promise<void> {
  const { prompt, document, provider, apiKey, baseUrl, model = provider === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o-mini', history } = req;
  const p = providers[provider];
  if (!p) throw new Error(`Unknown provider: ${provider}`);
  if (!apiKey && provider !== 'lmstudio') throw new Error('API key required');
  const system = buildSystemPrompt(document);
  const user = prompt; // Full document already included in system prompt to mirror Electron
  const params: ProviderStreamParams = { model, apiKey: apiKey || '', baseUrl, system, user, history };
  const streamId = `stream_${Date.now()}`;
  let started = false;
  let acc = '';
  let outBuffer = '';
  try {
    for await (const chunk of p(params, opts?.signal)) {
      acc += chunk;
      if (!started) {
        const { isStreaming, streamConfig, cleanContent } = detectStreamingIntent(acc);
        if (isStreaming && streamConfig) {
          started = true;
          opts?.callbacks?.onStart?.(streamConfig);
          startStreamingEdit({ id: streamId, ...streamConfig });
          if (cleanContent) outBuffer += cleanContent;
          acc = '';
        }
      } else {
        outBuffer += chunk;
      }

      if (started && outBuffer) {
        const END_A = '<!-- STREAM_END -->';
        const END_B = '@end-stream';
        const endIdxA = outBuffer.indexOf(END_A);
        const endIdxB = outBuffer.indexOf(END_B);
        const endIdx = endIdxA >= 0 ? endIdxA : endIdxB;
        if (endIdx >= 0) {
          const before = outBuffer.slice(0, endIdx);
          if (before.trim()) {
            opts?.callbacks?.onContent?.(before);
            streamContent(streamId, before);
          }
          endStreamingEdit(streamId);
          opts?.callbacks?.onEnd?.();
          return;
        }
        const GUARD = 32;
        if (outBuffer.length > GUARD) {
          const emit = outBuffer.slice(0, outBuffer.length - GUARD);
          if (emit) {
            opts?.callbacks?.onContent?.(emit);
            streamContent(streamId, emit);
          }
          outBuffer = outBuffer.slice(-GUARD);
        }
      }
    }
  } finally {
    if (started) {
      if (outBuffer) {
        const END_A = '<!-- STREAM_END -->';
        const END_B = '@end-stream';
        const cut = outBuffer.split(END_A)[0].split(END_B)[0];
        if (cut.trim()) {
          opts?.callbacks?.onContent?.(cut);
          streamContent(streamId, cut);
        }
      }
      endStreamingEdit(streamId);
      opts?.callbacks?.onEnd?.();
    }
  }
}
