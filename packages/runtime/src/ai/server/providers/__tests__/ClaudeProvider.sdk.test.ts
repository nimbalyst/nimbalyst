// @vitest-environment node
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// AIProvider constructs this queue at module load. Keep repository imports out
// before importing the real provider; request and continuation logic stay real.
vi.mock('../../../../storage/repositories/AgentMessageWriteQueue', () => ({
  AgentMessageWriteQueue: class {
    enqueue() { return Promise.resolve(); }
    onBatch() { return () => {}; }
    flush() { return Promise.resolve(); }
  },
}));

let ClaudeProvider: typeof import('../ClaudeProvider').ClaudeProvider;
let respond: (init: RequestInit) => Response;
let requests: { url: string; init: RequestInit; body: any }[];
const key = 'dummy-provider-key';
const frame = (data: any) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const usage = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };
function frames(text: string, stop = 'end_turn', tool = false, input = 10, output = 4) {
  const events: any[] = [
    { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, input_tokens: input } } },
    { type: 'ping' },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', future_optional: true } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 2) } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(2) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'future_optional_event', tools_changed: true },
  ];
  if (tool) events.push(
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'fixtureTool', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"value":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '7}' } },
    { type: 'content_block_stop', index: 1 },
  );
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: output }, future_optional: true }, { type: 'message_stop' });
  return events.map(frame).join('');
}
const response = (wire: string) => new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
async function collect<T>(iter: AsyncIterable<T>) { const out: T[] = []; for await (const x of iter) out.push(x); return out; }
async function provider() {
  const instance = new ClaudeProvider();
  vi.spyOn(instance as any, 'logAgentMessage').mockResolvedValue(undefined);
  vi.spyOn(instance as any, 'logError').mockImplementation(() => {});
  await instance.initialize({ apiKey: key, model: 'claude:fixture-model', baseUrl: 'https://unforwarded.invalid', maxTokens: 123 });
  return instance;
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init: RequestInit) => {
    const address = String(url);
    if (address !== 'https://api.anthropic.com/v1/messages' || init.method !== 'POST') throw new Error(`Unexpected HTTP ${init.method} ${address}`);
    requests.push({ url: address, init, body: JSON.parse(String(init.body)) });
    return respond(init);
  }));
  ClaudeProvider = (await import('../ClaudeProvider')).ClaudeProvider;
});
// The SDK falls back to ANTHROPIC_BASE_URL, which would send requests past the fetch stub.
beforeEach(() => { vi.stubEnv('ANTHROPIC_BASE_URL', undefined); requests = []; respond = () => response(frames('hello')); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('ClaudeProvider through actual SDK MessageStream', () => {
  it('parses tool JSON, sends its fake result in the next request and completes once with summed usage', async () => {
    const instance = await provider();
    const { toolRegistry } = await import('../../../tools/definitions');
    toolRegistry.register({ name: 'fixtureTool', description: 'in-memory test tool', parameters: { type: 'object', properties: { value: { type: 'number' } } } });
    const executeTool = vi.fn(async () => ({ success: true, content: 'fake result' }));
    instance.registerToolHandler({ executeTool });
    respond = () => requests.length === 1 ? response(frames('checking', 'tool_use', true, 10, 4)) : response(frames('finished', 'end_turn', false, 20, 6));
    const chunks = await collect(instance.sendMessage('hello', { content: 'document', filePath: '/synthetic/document.md' }, 'synthetic-session'));
    expect(executeTool).toHaveBeenCalledExactlyOnceWith('fixtureTool', { value: 7 });
    expect(requests).toHaveLength(2);
    expect(requests[0].body).toMatchObject({ model: 'fixture-model', max_tokens: 123, stream: true });
    expect(requests[0].body.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'fixtureTool' })]));
    expect(requests[1].body.messages.slice(-2)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'tool-1', name: 'fixtureTool', input: { value: 7 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'fake result' }] },
    ]);
    expect(chunks.filter(c => c.type === 'text').map(c => c.content).join('')).toBe('checkingfinished');
    expect(chunks.filter(c => c.type === 'tool_call')).toHaveLength(1);
    expect(chunks.filter(c => c.type === 'complete')).toEqual([expect.objectContaining({ content: 'finished', isComplete: true,
      usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40, cache_read_input_tokens: 6, cache_creation_input_tokens: 4 } })]);
    expect((instance as any).logAgentMessage).toHaveBeenCalled();
    toolRegistry.unregister('fixtureTool');
  });

  it('keeps partial text/usage on context-window stop without model change or automatic retry', async () => {
    const instance = await provider();
    respond = () => response(frames('partial answer', 'model_context_window_exceeded', false, 17, 5));
    const chunks = await collect(instance.sendMessage('hello'));
    expect(chunks.filter(c => c.type === 'text').map(c => c.content).join('')).toBe('partial answer');
    expect(chunks.filter(c => c.type === 'complete')).toEqual([expect.objectContaining({ content: 'partial answer', usage: {
      input_tokens: 17, output_tokens: 5, total_tokens: 22, cache_read_input_tokens: 3, cache_creation_input_tokens: 2,
    } })]);
    expect(requests).toHaveLength(1);
    expect(requests[0].body.model).toBe('fixture-model');
  });

  it('rejects an absent configured key before fetch and reports real API errors without completion', async () => {
    await expect(new ClaudeProvider().initialize({})).rejects.toThrow('API key required');
    expect(requests).toHaveLength(0);
    const instance = await provider();
    respond = () => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture API error' } }, { status: 400 });
    const chunks = await collect(instance.sendMessage('hello', undefined, 'synthetic-session'));
    expect(chunks).toEqual([{ type: 'error', error: expect.stringContaining('fixture API error') }]);
    expect(requests).toHaveLength(1);
    expect((instance as any).logError).toHaveBeenCalledOnce();
  });

  it('characterizes unforwarded baseURL/unattached abort and closes HTTP on consumer return', async () => {
    const instance = await provider();
    let signal!: AbortSignal;
    let bodyCancelled = false;
    respond = init => {
      signal = init.signal!;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const abort = () => { bodyCancelled = true; controller.error(new DOMException('Body aborted', 'AbortError')); };
      const body = new ReadableStream<Uint8Array>({ start(c) {
        controller = c;
        const prefix = frames('first').split('event: content_block_stop')[0];
        c.enqueue(new TextEncoder().encode(prefix));
        signal.addEventListener('abort', abort, { once: true });
      }, cancel() { bodyCancelled = true; signal.removeEventListener('abort', abort); } });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const iter = instance.sendMessage('hello');
    expect((await iter.next()).value).toMatchObject({ type: 'text', content: 'fi' });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(new Headers(requests[0].init.headers).get('x-api-key')).toBe(key);
    expect(new Headers(requests[0].init.headers).get('anthropic-beta')).toBe('fine-grained-tool-streaming-2025-05-14');
    const providerController = (instance as any).abortController as AbortController;
    expect(signal).not.toBe(providerController.signal);
    instance.abort();
    expect(providerController.signal.aborted).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(bodyCancelled).toBe(false);
    expect(iter.return).toBeTypeOf('function');
    await iter.return!(undefined);
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 500, interval: 1 });
    expect(bodyCancelled).toBe(true);
    expect((instance as any).abortController).toBeNull();
    expect(requests).toHaveLength(1);
  });
});
