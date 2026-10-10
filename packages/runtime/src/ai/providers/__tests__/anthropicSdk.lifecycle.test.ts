// @vitest-environment node
import { getEventListeners } from 'node:events';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({ start: vi.fn(), content: vi.fn(), end: vi.fn(), execute: vi.fn() }));
vi.mock('../../tools', () => ({ toolRegistry: {}, ToolExecutor: { execute: seams.execute } }));
vi.mock('../../editorBridge', () => ({ startStreamingEdit: seams.start, streamContent: seams.content, endStreamingEdit: seams.end }));

const baseURL = 'https://sdk-fixture.invalid';
const key = 'dummy-chat-key';
const params = { model: 'fixture-model', max_tokens: 32, messages: [{ role: 'user' as const, content: 'hello' }] };
const caller = { model: 'fixture-model', apiKey: key, baseUrl: baseURL, system: 'system', user: 'hello', history: [{ role: 'assistant' as const, content: 'history' }] };
let Anthropic: typeof import('@anthropic-ai/sdk').default;
let respond: (init: RequestInit) => Response | Promise<Response>;
let requests: { url: string; init: RequestInit; body: any }[];
const listeners = (signal: AbortSignal) => getEventListeners(signal, 'abort').length;
const frame = (data: any) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const delta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text }, optional_future: true });
const sse = (texts: string[]) => {
  const wire = new TextEncoder().encode(texts.map(t => frame(delta(t))).join('') + frame({ type: 'ping' }));
  // Split the actual wire inside event names, JSON and frame delimiters.
  return new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < wire.length; i += 13) c.enqueue(wire.slice(i, i + 13));
    c.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
};
const json = () => Response.json({ id: 'fixture-message', content: [{ type: 'text', text: 'ok' }] });
const apiError = (status = 400) => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture rejection' } }, { status, headers: { 'retry-after-ms': '1' } });
const client = (maxRetries = 0) => new Anthropic({ apiKey: key, baseURL, maxRetries });
async function collect<T>(iter: AsyncIterable<T>) { const out: T[] = []; for await (const x of iter) out.push(x); return out; }

// A body remains genuinely pending after headers, and responds to the SDK's
// internal fetch signal. No real HTTP, timer-driven body, or SDK cleanup stub.
function pendingBody(init: RequestInit, prefix: string, contentType: string) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const signal = init.signal!;
  const abort = () => { cancelled = true; controller.error(new DOMException('Body aborted', 'AbortError')); };
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; if (prefix) c.enqueue(new TextEncoder().encode(prefix)); signal.addEventListener('abort', abort, { once: true }); },
    cancel() { cancelled = true; signal.removeEventListener('abort', abort); },
  });
  return { response: new Response(body, { headers: { 'content-type': contentType } }), signal,
    finish(text = '') { signal.removeEventListener('abort', abort); if (text) controller.enqueue(new TextEncoder().encode(text)); controller.close(); },
    get cancelled() { return cancelled; } };
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init: RequestInit) => {
    const address = String(url);
    if (!((address === baseURL + '/v1/messages' && init.method === 'POST') || (address === baseURL + '/v1/models' && init.method === 'GET'))) throw new Error(`Unexpected HTTP ${init.method} ${address}`);
    if (requests.length === 0) console.log('actual request SDK version', new Headers(init.headers).get('x-stainless-package-version'));
    requests.push({ url: address, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return respond(init);
  }));
  Anthropic = (await import('@anthropic-ai/sdk')).default;
});
beforeEach(() => { requests = []; respond = json; vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('real SDK caller-signal ownership', () => {
  it('retires each JSON, consumed SSE and retry attempt on one long-lived signal', async () => {
    const signal = new AbortController().signal;
    const baseline = listeners(signal);
    const counts: { phase: string; count: number }[] = [];
    respond = () => { counts.push({ phase: 'fetch', count: listeners(signal) }); return json(); };
    for (let i = 0; i < 3; i++) {
      await client().messages.create(params, { signal });
      counts.push({ phase: `json-${i}-settled`, count: listeners(signal) });
      console.log('caller-signal count', counts.at(-1));
      expect.soft(listeners(signal), `JSON ${i} settled`).toBe(baseline);
    }
    respond = () => { counts.push({ phase: 'fetch-sse', count: listeners(signal) }); return sse(['a', 'b']); };
    for (let i = 0; i < 3; i++) {
      const stream = await client().messages.create({ ...params, stream: true }, { signal });
      // The SDK consumes ping comments/events without exposing them.
      expect(await collect(stream)).toHaveLength(2);
      counts.push({ phase: `sse-${i}-settled`, count: listeners(signal) });
      console.log('caller-signal count', counts.at(-1));
      expect.soft(listeners(signal), `SSE ${i} settled`).toBe(baseline);
    }
    let attempt = 0;
    respond = () => {
      counts.push({ phase: `retry-${attempt}`, count: listeners(signal) });
      expect.soft(listeners(signal), 'only current retry attempt owns a listener').toBe(baseline + 1);
      return attempt++ === 0 ? apiError(503) : json();
    };
    await client(1).messages.create(params, { signal });
    counts.push({ phase: 'retry-settled', count: listeners(signal) });
    console.log('caller-signal counts', JSON.stringify(counts));
    expect(attempt).toBe(2);
    expect(signal.aborted).toBe(false);
    expect.soft(listeners(signal)).toBe(baseline);
  });

  it.each(['json', 'sse'] as const)('keeps %s cancellation attached after headers until body consumption', async kind => {
    const controller = new AbortController();
    const baseline = listeners(controller.signal);
    let body: ReturnType<typeof pendingBody>;
    let headers!: () => void;
    const headersSeen = new Promise<void>(r => { headers = r; });
    respond = init => { body = pendingBody(init, kind === 'json' ? '{' : '', kind === 'json' ? 'application/json' : 'text/event-stream'); headers(); return body.response; };
    const request = client().messages.create({ ...params, stream: kind === 'sse' }, { signal: controller.signal });
    const consumption = kind === 'sse' ? request.then(stream => collect(stream as any)) : request.then(x => x);
    // Raw SDK SSE iteration treats AbortError as normal iterator termination.
    const settled = kind === 'json' ? expect(consumption).rejects.toThrow() : consumption;
    await headersSeen;
    await vi.waitFor(() => expect(body!.response.body!.locked).toBe(true), { timeout: 500, interval: 1 });
    expect(listeners(controller.signal)).toBe(baseline + 1);
    expect(body!.signal.aborted).toBe(false);
    controller.abort();
    await settled;
    expect(body!.signal.aborted).toBe(true);
    expect(body!.cancelled).toBe(true);
    expect(listeners(controller.signal)).toBe(baseline);
  });

  it.each(['json', 'sse'] as const)('releases pending %s only after normal body completion', async kind => {
    const signal = new AbortController().signal;
    let body: ReturnType<typeof pendingBody>;
    let headers!: () => void;
    const seen = new Promise<void>(r => { headers = r; });
    respond = init => { body = pendingBody(init, '', kind === 'json' ? 'application/json' : 'text/event-stream'); headers(); return body.response; };
    const request = client().messages.create({ ...params, stream: kind === 'sse' }, { signal });
    const done = kind === 'sse' ? request.then(stream => collect(stream as any)) : request.then(x => x);
    await seen;
    await vi.waitFor(() => expect(body!.response.body!.locked).toBe(true), { timeout: 500, interval: 1 });
    expect(listeners(signal)).toBe(1);
    body!.finish(kind === 'json' ? '{"id":"complete"}' : frame(delta('complete')));
    await done;
    expect(listeners(signal)).toBe(0);
  });

  it.each(['malformed-json', 'malformed-sse', 'api-error', 'network'] as const)('retires %s failures', async failure => {
    const signal = new AbortController().signal;
    respond = () => {
      if (failure === 'network') throw new TypeError('fixture network failure');
      if (failure === 'api-error') return apiError();
      return new Response(failure === 'malformed-json' ? '{' : 'event: content_block_delta\ndata: {\n\n', { headers: { 'content-type': failure === 'malformed-json' ? 'application/json' : 'text/event-stream' } });
    };
    const run = async () => {
      if (failure === 'malformed-sse') await collect(await client().messages.create({ ...params, stream: true }, { signal }));
      else await client().messages.create(params, { signal });
    };
    await expect(run()).rejects.toThrow();
    expect(listeners(signal)).toBe(0);
  });

  it('early iterator return aborts the real pending stream and retires its caller listener', async () => {
    const signal = new AbortController().signal;
    let body: ReturnType<typeof pendingBody>;
    respond = init => { body = pendingBody(init, frame(delta('first')), 'text/event-stream'); return body.response; };
    const stream = await client().messages.create({ ...params, stream: true }, { signal });
    for await (const event of stream) { expect(event.type).toBe('content_block_delta'); break; }
    expect(body!.signal.aborted).toBe(true);
    expect(body!.cancelled).toBe(true);
    expect(listeners(signal)).toBe(0);
  });
});

describe('actual Anthropic caller paths', () => {
  it('forwards config/history/signal and emits split SSE text without dispatching tools', async () => {
    const { streamAnthropic } = await import('../anthropic');
    const controller = new AbortController();
    respond = () => {
      const wire = sse(['hel', 'lo']);
      return wire;
    };
    expect(await collect(streamAnthropic(caller, controller.signal))).toEqual(['hel', 'lo']);
    expect(requests[0].url).toBe(baseURL + '/v1/messages');
    expect(new Headers(requests[0].init.headers).get('x-api-key')).toBe(key);
    expect(requests[0].body).toMatchObject({ model: caller.model, system: 'system', stream: true, messages: [{ role: 'assistant', content: 'history' }, { role: 'user', content: 'hello' }] });
    expect(requests[0].body.tools).toBeUndefined();
    expect(seams.execute).not.toHaveBeenCalled();
    expect(listeners(controller.signal)).toBe(0);
  });

  it('propagates API errors and closes a pending body on caller early return', async () => {
    const { streamAnthropic } = await import('../anthropic');
    respond = () => apiError();
    await expect(collect(streamAnthropic(caller))).rejects.toThrow('fixture rejection');
    let body: ReturnType<typeof pendingBody>;
    const controller = new AbortController();
    respond = init => { body = pendingBody(init, frame(delta('first')), 'text/event-stream'); return body.response; };
    for await (const text of streamAnthropic(caller, controller.signal)) { expect(text).toBe('first'); break; }
    expect(body!.signal.aborted).toBe(true);
    expect(listeners(controller.signal)).toBe(0);
  });

  it('uses the real provider map for split edit markers/EOF, with the configured-key gate', async () => {
    const { sendStreamingEditWithProvider } = await import('../../client');
    const req = { provider: 'anthropic' as const, apiKey: key, baseUrl: baseURL, model: caller.model, prompt: 'edit', document: { content: 'old' } };
    await expect(sendStreamingEditWithProvider({ ...req, apiKey: '' })).rejects.toThrow('API key required');
    expect(requests).toHaveLength(0);
    const controller = new AbortController();
    respond = () => sse(['<!-- STREAM_', 'EDIT: {"position":"cursor","mode":"after"} -->\n', 'new ', 'text']);
    const onEnd = vi.fn();
    await sendStreamingEditWithProvider(req, { signal: controller.signal, callbacks: { onEnd } });
    expect(seams.start).toHaveBeenCalledWith(expect.objectContaining({ position: 'cursor', mode: 'after' }));
    expect(seams.content.mock.calls.map(c => c[1]).join('')).toBe('new text');
    expect(seams.end).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(new Headers(requests[0].init.headers).get('x-api-key')).toBe(key);
    expect(requests[0].url).toBe(baseURL + '/v1/messages');
    expect(listeners(controller.signal)).toBe(0);
  });

  it('characterizes the existing explicit-end double finalization without repairing it', async () => {
    const { sendStreamingEditWithProvider } = await import('../../client');
    respond = () => sse(['<!-- STREAM_EDIT: {"position":"cursor","mode":"after"} -->\ntext', '<!-- STREAM_', 'END -->']);
    const onEnd = vi.fn();
    await sendStreamingEditWithProvider({ provider: 'anthropic', apiKey: key, baseUrl: baseURL, prompt: 'edit' }, { callbacks: { onEnd } });
    expect(seams.end).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenCalledTimes(2);
    expect(seams.content.mock.calls.map(c => c[1])).toEqual(['text', 'text']);
  });

  it('finalizes a started edit on SSE error and on cancellation after headers', async () => {
    const { sendStreamingEditWithProvider } = await import('../../client');
    const req = { provider: 'anthropic' as const, apiKey: key, baseUrl: baseURL, prompt: 'edit' };
    const prefix = frame(delta('<!-- STREAM_EDIT: {"position":"cursor","mode":"after"} -->\npartial'));
    respond = () => new Response(prefix + frame({ type: 'error', error: { type: 'invalid_request_error', message: 'edit error' } }), { headers: { 'content-type': 'text/event-stream' } });
    await expect(sendStreamingEditWithProvider(req)).rejects.toThrow('edit error');
    expect(seams.end).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    let body: ReturnType<typeof pendingBody>;
    const controller = new AbortController();
    const started = new Promise<void>(resolve => seams.start.mockImplementationOnce(() => resolve()));
    respond = init => { body = pendingBody(init, prefix, 'text/event-stream'); return body.response; };
    const done = sendStreamingEditWithProvider(req, { signal: controller.signal });
    await started;
    expect(listeners(controller.signal)).toBe(1);
    controller.abort();
    await done;
    expect(body!.signal.aborted).toBe(true);
    expect(seams.end).toHaveBeenCalledTimes(1);
    expect(listeners(controller.signal)).toBe(0);
  });

  it('maps real SDK model responses and falls back for no key, malformed body and API error', async () => {
    const { getAnthropicModels } = await import('../../models');
    const fallback = await getAnthropicModels();
    expect(requests).toHaveLength(0);
    respond = () => Response.json({ data: [{ id: 'm1', display_name: 'Model one' }, { id: 'm2' }], has_more: false, first_id: 'm1', last_id: 'm2' });
    expect(await getAnthropicModels(key, baseURL)).toEqual([{ id: 'm1', name: 'Model one' }, { id: 'm2', name: 'm2' }]);
    expect(requests[0].url).toBe(baseURL + '/v1/models');
    expect(new Headers(requests[0].init.headers).get('x-api-key')).toBe(key);
    respond = () => new Response('{', { headers: { 'content-type': 'application/json' } });
    expect(await getAnthropicModels(key, baseURL)).toEqual(fallback);
    respond = () => apiError();
    expect(await getAnthropicModels(key, baseURL)).toEqual(fallback);
  });
});
