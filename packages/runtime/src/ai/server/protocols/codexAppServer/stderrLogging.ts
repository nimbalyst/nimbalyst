import type { Readable } from 'node:stream';
import { previewForLog } from './notificationDiagnostics';

// Match only the transport's connection diagnostic, not MCP tool failures,
// authentication errors, or other app-server stderr. Optional local companions
// are routinely closed while an unrelated agent session is running.
function unavailableLocalEndpoint(line: string): string | undefined {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, '');
  if (!plain.includes('rmcp::transport::worker') ||
      !plain.includes('worker quit with fatal: Transport channel closed, when Client(HttpRequest(')) return;
  const match = plain.match(/http\/request failed: error sending request for url \((https?:\/\/[^\s)]+)\)/);
  if (!match) return;
  try {
    const url = new URL(match[1]);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
    return `${url.origin}${url.pathname}`;
  } catch {
    return;
  }
}

export function captureCodexStderr(stream: Readable): string[] {
  const tail: string[] = [];
  const unavailable = new Set<string>();
  let pending = '';
  const logLine = (line: string) => {
    if (!line.trim()) return;
    const endpoint = unavailableLocalEndpoint(line);
    if (endpoint) {
      if (!unavailable.has(endpoint)) {
        unavailable.add(endpoint);
        console.info(`[CODEX][MCP] Local integration unavailable: ${endpoint} (further connection diagnostics suppressed for this session)`);
      }
      return;
    }
    console.warn('[CODEX][APPSERVER][stderr]', previewForLog(line.trim(), 800));
  };
  const flush = () => {
    logLine(pending);
    pending = '';
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    // Keep original stderr for initialization/crash diagnostics, including the
    // connection messages omitted from routine logging.
    tail.push(chunk);
    while (tail.length > 0 && tail.join('').length > 16 * 1024) tail.shift();
    // Stream chunks are not lines: classify separately so an offline message
    // cannot hide an unrelated error delivered in the same chunk.
    const lines = (pending + chunk).split('\n');
    pending = lines.pop()!;
    for (const line of lines) logLine(line);
    // A malformed child must not grow an unterminated line without bound.
    if (pending.length > 16 * 1024) flush();
  });
  stream.once('end', flush);
  stream.once('close', flush);
  return tail;
}
