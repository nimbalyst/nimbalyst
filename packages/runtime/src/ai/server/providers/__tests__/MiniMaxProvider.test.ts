import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { MiniMaxProvider, MINIMAX_ENDPOINTS, resolveMiniMaxEndpoint } from '../MiniMaxProvider';
import { ModelRegistry } from '../../ModelRegistry';
import { DEFAULT_MODELS } from '../../../modelConstants';
import type { ChatAttachment, Message, ProviderConfig } from '../../types';

// Isolate editor/database infrastructure, not providers, SDKs, or their HTTP transport.
vi.mock('../../../prompt', () => ({ buildSystemPrompt: () => 'Test system prompt' }));
vi.mock('../../../tools', () => ({
  AI_TOOLS: [], executeTool: vi.fn(), toOpenAITools: () => [], toolRegistry: { getAll: () => [] },
}));
vi.mock('../../../../storage/repositories/AgentMessageWriteQueue', () => ({ AgentMessageWriteQueue: class {} }));

const apiKey = 'test-minimax-key';
const models = ['MiniMax-M3.1-Flash', 'MiniMax-M3'];
const routes = [
  { protocol: 'anthropic', region: 'global_en', url: 'https://api.minimax.io/anthropic/v1/messages' },
  { protocol: 'anthropic', region: 'cn_zh', url: 'https://api.minimaxi.com/anthropic/v1/messages' },
  { protocol: 'openai', region: 'global_en', url: 'https://api.minimax.io/v1/chat/completions' },
  { protocol: 'openai', region: 'cn_zh', url: 'https://api.minimaxi.com/v1/chat/completions' },
] as const;

function responseStream(protocol: string, model: string): string {
  if (protocol === 'openai') {
    return [
      { id: 'chat-test', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
      { id: 'chat-test', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  }
  return [
    { type: 'message_start', message: { id: 'msg-test', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ].map(chunk => `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`).join('');
}

describe('MiniMaxProvider', () => {
  let server: Server;
  let localOrigin: string;
  const nativeFetch = globalThis.fetch;
  let requestedUrls: string[];
  let requests: { path: string; headers: Record<string, unknown>; body: any }[];

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ path: request.url!, headers: request.headers, body });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(responseStream(request.url!.endsWith('/messages') ? 'anthropic' : 'openai', body.model));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
    localOrigin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  beforeEach(() => {
    requests = [];
    requestedUrls = [];
    ModelRegistry.clearCache('minimax');
    for (const method of ['log', 'info', 'warn', 'error', 'group', 'groupEnd'] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
    // Keep the real SDK serialization, fetch, HTTP server and SSE parser; redirect only the host.
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedUrls.push(url.href);
      return nativeFetch(`${localOrigin}${url.pathname}${url.search}`, init);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function send(config: ProviderConfig, extra: { messages?: Message[]; attachments?: ChatAttachment[] } = {}) {
    const provider = new MiniMaxProvider();
    await provider.initialize({ apiKey, ...config });
    const chunks = [];
    try {
      for await (const chunk of provider.sendMessage('Hello', undefined, undefined, extra.messages, undefined, extra.attachments)) chunks.push(chunk);
    } finally {
      provider.destroy();
    }
    expect(chunks.filter(chunk => chunk.type === 'error')).toEqual([]);
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text', content: 'Hello' }));
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'complete', isComplete: true }));
    expect(requests).toHaveLength(1);
    return requests[0];
  }

  it('exposes Flash then M3 through the registry and shared default', async () => {
    const catalog = await ModelRegistry.getModelsForProvider('minimax');
    expect(catalog.map(model => model.id)).toEqual(models.map(model => `minimax:${model}`));
    expect(catalog.every(model => model.contextWindow === 1000000)).toBe(true);
    expect(await ModelRegistry.getDefaultModel('minimax')).toBe('minimax:MiniMax-M3.1-Flash');
    expect(DEFAULT_MODELS.minimax).toBe('minimax:MiniMax-M3.1-Flash');
    expect(MiniMaxProvider.isModelAllowed('minimax:MiniMax-M3.1-Flash')).toBe(true);
    expect(MiniMaxProvider.isModelAllowed('minimax:MiniMax-M3')).toBe(true);
    expect(MiniMaxProvider.isModelAllowed('minimax:MiniMax-M2.7')).toBe(false);
  });

  for (const route of routes) {
    for (const model of models) {
      it(`serializes ${model} through ${route.region} ${route.protocol} SDK HTTP`, async () => {
        const request = await send({
          model: `minimax:${model}`, baseUrl: MINIMAX_ENDPOINTS[route.region][route.protocol],
        });
        expect(requestedUrls).toEqual([route.url]);
        expect(request.path).toBe(new URL(route.url).pathname);
        if (route.protocol === 'anthropic') {
          expect(request.headers['x-api-key']).toBe(apiKey);
        } else {
          expect(request.headers.authorization).toBe(`Bearer ${apiKey}`);
        }
        expect(request.body.model).toBe(model);
        expect(request.body.stream).toBe(true);
        // Omission is valid for Flash: never send disabled thinking or effort=none.
        expect(request.body).not.toHaveProperty('thinking');
        expect(request.body).not.toHaveProperty('reasoning_effort');
        expect(request.body).not.toHaveProperty('output_config');
        expect(request.body.messages.at(-1)).toEqual({ role: 'user', content: 'Hello' });
      });
    }
  }

  for (const protocol of ['anthropic', 'openai'] as const) {
    it(`uses Flash for a fresh ${protocol} provider without overriding explicit selections`, async () => {
      const request = await send({ baseUrl: MINIMAX_ENDPOINTS.global_en[protocol] });
      expect(request.body.model).toBe('MiniMax-M3.1-Flash');
    });

    for (const model of ['minimax:MiniMax-M2.7', 'minimax:MiniMax-M2.5', 'minimax:custom-deployment', 'custom-raw-model']) {
      it(`preserves saved/custom ${model} in ${protocol} requests`, async () => {
        const request = await send({ model, baseUrl: MINIMAX_ENDPOINTS.global_en[protocol] });
        expect(request.body.model).toBe(model.replace(/^minimax:/, ''));
      });
    }

    it(`preserves text history and image attachment payloads in ${protocol}`, async () => {
      const fixture = new URL('../../../../editor/images/emoji/1F600.png', import.meta.url);
      const bytes = await readFile(fixture);
      const base64 = bytes.toString('base64');
      const attachment = { id: 'image-test', type: 'image' as const, filepath: fixture.pathname, mimeType: 'image/png', filename: 'test.png', size: bytes.length, addedAt: 1 };
      const history = [{ role: 'user', content: 'Earlier request' }, { role: 'assistant', content: 'Earlier answer' }] as Message[];
      const request = await send({ baseUrl: MINIMAX_ENDPOINTS.global_en[protocol] }, { messages: history, attachments: [attachment] });
      expect(request.body.messages).toEqual(expect.arrayContaining(history));
      const content = request.body.messages.at(-1).content;
      expect(content.at(-1)).toEqual({ type: 'text', text: 'Hello' });
      if (protocol === 'anthropic') {
        expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } });
      } else {
        expect(content[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } });
      }
      expect(history).toEqual([{ role: 'user', content: 'Earlier request' }, { role: 'assistant', content: 'Earlier answer' }]);
    });
  }

  it('normalizes known endpoints and rejects unsupported hosts', () => {
    expect(resolveMiniMaxEndpoint('https://api.minimaxi.com/anthropic/')).toEqual({
      baseUrl: 'https://api.minimaxi.com/anthropic', protocol: 'anthropic', region: 'cn_zh',
    });
    expect(() => resolveMiniMaxEndpoint('https://example.com/v1')).toThrow('Unsupported MiniMax endpoint');
  });

  it('rejects a missing API key before making an HTTP request', async () => {
    await expect(new MiniMaxProvider().initialize({})).rejects.toThrow('API key required for MiniMax provider');
    expect(requestedUrls).toEqual([]);
  });
});
