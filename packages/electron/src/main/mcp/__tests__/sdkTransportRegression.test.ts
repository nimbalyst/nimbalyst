// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const LIMIT = 10 * 1024 * 1024;
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'transport-regression', version: '1' },
} };
const call = (id: number, text = '') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'pending', arguments: { text } } });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
function request(body?: unknown, contentType = 'application/json', method = 'POST') {
  return new Request('http://localhost/mcp', { method, headers: {
    accept: 'application/json, text/event-stream', 'content-type': contentType,
    'mcp-session-id': 'fixture-session', 'mcp-protocol-version': '2025-03-26',
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function httpFixture(options = {}) {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => 'fixture-session', ...options });
  const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
  cleanups.push(() => server.close());
  await server.connect(transport);
  return { transport, server };
}
async function stdioFixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const transport = new StdioServerTransport(input, output);
  const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
  const errors: Error[] = [];
  const closed = vi.fn();
  server.onerror = error => errors.push(error);
  server.onclose = closed;
  cleanups.push(async () => { await server.close(); input.destroy(); output.destroy(); });
  await server.connect(transport);
  return { input, server, errors, closed };
}

// Exercise the low-level Server and real transport core used by the app's Node
// adapter, without loading Electron, native modules or provider credentials.
describe('SDK transport boundaries', () => {
  it('rejects misleading media through the actual Node HTTP adapter on loopback before dispatch', async () => {
    const transport = new StreamableHTTPServerTransport();
    const server = new Server({ name: 'node-fixture', version: '1' });
    cleanups.push(() => server.close());
    await server.connect(transport);
    const dispatch = vi.fn();
    const original = transport.onmessage!;
    transport.onmessage = (...args) => { dispatch(...args); original(...args); };
    const http = createServer((req, res) => {
      void transport.handleRequest(req, res).catch(() => res.destroy());
    });
    cleanups.push(() => new Promise<void>((resolve, reject) => {
      http.closeAllConnections();
      http.close(error => error ? reject(error) : resolve());
    }));
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, {
      method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'text/plain; a=application/json' },
      body: JSON.stringify(initialize), signal: AbortSignal.timeout(1500),
    });
    await response.text();
    expect.soft(response.status).toBe(415);
    expect.soft(dispatch).not.toHaveBeenCalled();
  });

  it('classifies media before dispatch, retaining charset/case and unambiguous malformed parameters', async () => {
    for (const [contentType, status] of [
      ['text/plain; a=application/json', 415],
      ['application/json, text/plain', 415],
      ['application/json; charset=utf-8, application/json', 415],
      ['application/json; charset=utf-8', 200],
      ['Application/JSON; Charset=UTF-8', 200],
      ['application/json; charset=', 200],
    ] as const) {
      const { transport } = await httpFixture();
      const dispatch = vi.fn();
      const original = transport.onmessage!;
      transport.onmessage = (...args) => { dispatch(...args); original(...args); };
      const response = await transport.handleRequest(request(initialize, contentType));
      await response.text();
      expect.soft(response.status, contentType).toBe(status);
      expect.soft(dispatch.mock.calls.length, contentType).toBe(status === 200 ? 1 : 0);
    }
  });

  it('parses fragmented UTF-8/CRLF, multiple frames and a valid frame exactly at the unread limit', async () => {
    const { input, server, errors } = await stdioFixture();
    const texts: unknown[] = [];
    server.setRequestHandler(CallToolRequestSchema, async req => {
      texts.push(req.params.arguments?.text);
      return { content: [] };
    });
    const frame = Buffer.from(JSON.stringify(call(2, 'héλ')) + '\r\n');
    const split = frame.indexOf(Buffer.from('é')) + 1;
    input.write(frame.subarray(0, split));
    expect(texts).toEqual([]);
    input.write(Buffer.concat([frame.subarray(split), Buffer.from(JSON.stringify(call(3, 'second')) + '\n')]));
    await turn();
    const overhead = Buffer.byteLength(JSON.stringify(call(4)) + '\n');
    input.write(Buffer.from(JSON.stringify(call(4, 'x'.repeat(LIMIT - overhead))) + '\n'));
    await turn();
    expect(texts.slice(0, 2)).toEqual(['héλ', 'second']);
    expect((texts[2] as string).length).toBe(LIMIT - overhead);
    expect(errors).toEqual([]);
  });

  it.each(['unread fragments', 'one-chunk aggregate'] as const)('closes on %s overflow before parsing, aborts the handler and prevents later dispatch', async mode => {
    const { input, server, errors, closed } = await stdioFixture();
    const dispatched = vi.fn();
    const aborted = vi.fn();
    server.setRequestHandler(CallToolRequestSchema, async (_req, extra) => {
      dispatched();
      await new Promise<void>(resolve => extra.signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      return { content: [] };
    });
    input.write(JSON.stringify(call(2)) + '\n');
    await turn();
    if (mode === 'unread fragments') {
      input.write(Buffer.alloc(LIMIT, 32));
      expect(closed).not.toHaveBeenCalled();
      input.write(Buffer.from(' '));
    } else {
      // Individually small frames: the cap applies to the aggregate chunk
      // before parsing, rather than to semantic message size.
      const frame = Buffer.from(JSON.stringify(call(3, 'x'.repeat(1024 * 1024))) + '\n');
      const aggregate = Buffer.alloc(frame.length * (Math.floor(LIMIT / frame.length) + 1));
      for (let offset = 0; offset < aggregate.length; offset += frame.length) frame.copy(aggregate, offset);
      input.write(aggregate);
    }
    await turn();
    expect(errors.some(error => /buffer.*(size|limit)|exceed/i.test(error.message))).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    input.write(JSON.stringify(call(5)) + '\n');
    await turn();
    expect(dispatched).toHaveBeenCalledTimes(1);
  });

  it('emits only comments while a tool is pending and retires timers on completion, cancel/reconnect, DELETE and duplicate close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { transport, server } = await httpFixture();
    await (await transport.handleRequest(request(initialize))).text();
    let answer!: () => void;
    const dispatched = vi.fn();
    server.setRequestHandler(CallToolRequestSchema, async () => {
      dispatched();
      await new Promise<void>(resolve => { answer = resolve; });
      return { content: [{ type: 'text', text: 'answer' }] };
    });
    const response = await transport.handleRequest(request(call(2)));
    const reader = response.body!.getReader();
    cleanups.push(() => reader.cancel());
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(15000);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(': keepalive\n\n');
    expect(dispatched).toHaveBeenCalledTimes(1);
    answer();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"text":"answer"');
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const standalone = await transport.handleRequest(request(undefined, 'application/json', 'GET'));
    expect(vi.getTimerCount()).toBe(1);
    await standalone.body!.cancel();
    expect(vi.getTimerCount()).toBe(0);
    const replacement = await transport.handleRequest(request(undefined, 'application/json', 'GET'));
    expect(replacement.status).toBe(200);
    expect(vi.getTimerCount()).toBe(1);
    expect((await transport.handleRequest(request(undefined, 'application/json', 'DELETE'))).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
    await transport.close();
    expect(vi.getTimerCount()).toBe(0);
    expect((await replacement.body!.getReader().read()).done).toBe(true);
  });

  it.each(['body', 'session callback'] as const)('does not resurrect a transport closed during awaited %s', async seam => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const initialized = vi.fn(() => seam === 'session callback' ? gate : undefined);
    const { transport } = await httpFixture({ onsessioninitialized: initialized });
    const dispatch = vi.fn();
    transport.onmessage = dispatch;
    const req = request(initialize);
    if (seam === 'body') vi.spyOn(req, 'json').mockImplementation(async () => { await gate; return initialize; });
    const pending = transport.handleRequest(req);
    await turn();
    if (seam === 'session callback') expect(initialized).toHaveBeenCalledTimes(1);
    await transport.close();
    release();
    const response = await pending;
    cleanups.push(async () => { await response.body?.cancel(); });
    expect(response.status).toBe(404);
    expect(dispatch).not.toHaveBeenCalled();
    if (seam === 'body') expect(initialized).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
