// @vitest-environment node
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureCodexStderr } from '../stderrLogging';

function offline(url = 'http://127.0.0.1:27182/mcp') {
  return `\u001b[31mERROR\u001b[0m rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest("http/request failed: error sending request for url (${url})")))`;
}

function harness() {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const stream = new PassThrough();
  const tail = captureCodexStderr(stream);
  return { info, warn, stream, tail };
}

afterEach(() => vi.restoreAllMocks());

describe('Codex stderr logging', () => {
  it('summarizes repeated offline local MCP connections once without warning spam', () => {
    const h = harness();
    for (let i = 0; i < 3; i++) h.stream.write(offline() + '\n');
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledTimes(1);
    expect(h.info).toHaveBeenCalledWith('[CODEX][MCP] Local integration unavailable: http://127.0.0.1:27182/mcp (further connection diagnostics suppressed for this session)');
    expect(h.tail.join('')).toBe((offline() + '\n').repeat(3));
  });

  it('handles split lines and keeps an unrelated error in the same chunk visible', () => {
    const h = harness();
    const line = offline();
    h.stream.write(line.slice(0, 50));
    h.stream.write(line.slice(50) + '\nERROR codex_core: failed to save session\n');
    expect(h.info).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledExactlyOnceWith('[CODEX][APPSERVER][stderr]', 'ERROR codex_core: failed to save session');
  });

  it('preserves remote, authentication, and tool execution errors as warnings', () => {
    const h = harness();
    const lines = [offline('https://example.com/mcp'), 'ERROR rmcp: 401 Unauthorized', 'ERROR MCP tool call failed: fusion360.create_part'];
    h.stream.write(lines.join('\n') + '\n');
    expect(h.info).not.toHaveBeenCalled();
    expect(h.warn.mock.calls.map(call => call[1])).toEqual(lines);
  });

  it('summarizes endpoints independently and does not include URL credentials or queries', () => {
    const h = harness();
    h.stream.write(offline('http://user:secret@localhost:27182/mcp?token=secret') + '\n');
    h.stream.write(offline('http://[::1]:27183/mcp') + '\n');
    expect(h.info).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.info.mock.calls)).not.toContain('secret');
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('flushes unterminated errors when stderr closes', () => {
    const h = harness();
    h.stream.write('ERROR final diagnostic');
    h.stream.emit('close');
    expect(h.warn).toHaveBeenCalledExactlyOnceWith('[CODEX][APPSERVER][stderr]', 'ERROR final diagnostic');
  });
});
