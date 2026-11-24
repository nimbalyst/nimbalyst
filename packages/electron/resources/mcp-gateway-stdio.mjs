#!/usr/bin/env node
/**
 * stdio bridge to Nimbalyst's remote MCP gateway.
 *
 * For agent CLIs that only launch MCP servers as local processes. Reads
 * newline-delimited JSON-RPC on stdin, POSTs each message to the gateway URL
 * given as the first argument (Streamable HTTP), and writes responses and
 * server messages to stdout, one JSON message per line.
 *
 * It holds no remote credential and no OAuth logic: the gateway in the
 * Nimbalyst main process attaches those. Its only secret is the per-launch
 * loopback token, read from NIMBALYST_MCP_GATEWAY_TOKEN (environment, not argv,
 * so it is not visible in process listings). Only Node built-ins are used, so
 * it runs on Electron's bundled Node with ELECTRON_RUN_AS_NODE=1 and needs no
 * system Node or package download.
 */

const gatewayUrl = process.argv[2];
const token = process.env.NIMBALYST_MCP_GATEWAY_TOKEN || '';

if (!gatewayUrl) {
  process.stderr.write('mcp-gateway-stdio: missing gateway URL argument\n');
  process.exit(2);
}

let sessionId = null;
let protocolVersion = null;
let closing = false;
let streamStarted = false;

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function baseHeaders() {
  const headers = { Authorization: `Bearer ${token}` };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  return headers;
}

function errorFor(message, text) {
  if (message && message.id !== undefined && message.method !== undefined) {
    writeMessage({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: text } });
  }
}

function noteResponse(message) {
  // Track the negotiated protocol version from the initialize result.
  if (message && message.result && typeof message.result.protocolVersion === 'string') {
    protocolVersion = message.result.protocolVersion;
  }
}

function emit(message) {
  if (Array.isArray(message)) {
    for (const item of message) {
      noteResponse(item);
      writeMessage(item);
    }
    return;
  }
  noteResponse(message);
  writeMessage(message);
}

/** Parse a text/event-stream body and emit each `message` event's JSON data. */
async function consumeEventStream(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = '';
  let data = [];
  const dispatch = () => {
    if (data.length > 0 && (eventType === '' || eventType === 'message')) {
      try {
        emit(JSON.parse(data.join('\n')));
      } catch {
        // Not JSON: not an MCP message.
      }
    }
    eventType = '';
    data = [];
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.search(/\r?\n/)) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(buffer[newline] === '\r' ? newline + 2 : newline + 1);
      if (line === '') {
        dispatch();
      } else if (line.startsWith(':')) {
        // Comment / keep-alive.
      } else {
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') eventType = value;
        else if (field === 'data') data.push(value);
      }
    }
  }
  dispatch();
}

async function post(message) {
  let response;
  try {
    response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: { ...baseHeaders(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(message),
    });
  } catch {
    errorFor(message, 'Nimbalyst is not running, so this MCP server is unavailable.');
    return;
  }
  const newSession = response.headers.get('mcp-session-id');
  if (newSession) sessionId = newSession;

  // Server-initiated messages arrive on a GET stream, opened once the session
  // is initialized. `notifications/initialized` is normally answered 202, so
  // this has to happen before that early return.
  if (!streamStarted && sessionId && message.method === 'notifications/initialized' && response.ok) {
    streamStarted = true;
    void openServerStream();
  }

  const contentType = response.headers.get('content-type') || '';
  if (response.status === 202 || response.status === 204) {
    await response.body?.cancel();
    return;
  }
  if (contentType.includes('text/event-stream') && response.body) {
    await consumeEventStream(response.body);
  } else {
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed && (Array.isArray(parsed) || parsed.jsonrpc === '2.0')) {
      if (!Array.isArray(parsed) && parsed.error && parsed.id === null && message.id !== undefined) {
        parsed.id = message.id;
      }
      emit(parsed);
    } else if (!response.ok) {
      errorFor(message, `The MCP gateway answered HTTP ${response.status}.`);
    }
  }

}

/** Server-initiated messages arrive on a GET stream once a session exists. */
async function openServerStream() {
  let delay = 1000;
  while (!closing) {
    let response;
    try {
      response = await fetch(gatewayUrl, { method: 'GET', headers: { ...baseHeaders(), Accept: 'text/event-stream' } });
    } catch {
      response = null;
    }
    // No stream on this server (404/405), or this bridge's token is not
    // accepted (401/403, e.g. after Nimbalyst restarted): retrying cannot help.
    if (response && [401, 403, 404, 405].includes(response.status)) {
      await response.body?.cancel();
      return;
    }
    if (response && response.ok && response.body) {
      delay = 1000;
      try {
        await consumeEventStream(response.body);
      } catch {
        // Stream dropped; reconnect below.
      }
    } else {
      await response?.body?.cancel();
    }
    if (closing) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 30_000);
  }
}

async function shutdown() {
  if (closing) return;
  closing = true;
  if (sessionId) {
    try {
      await fetch(gatewayUrl, { method: 'DELETE', headers: baseHeaders() });
    } catch {
      // Nimbalyst may already be gone.
    }
  }
  process.exit(0);
}

let pending = Promise.resolve();
let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let newline;
  while ((newline = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, newline).trim();
    stdinBuffer = stdinBuffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    // initialize must finish (and yield the session id) before anything else
    // is sent; after that, requests run concurrently.
    if (message && message.method === 'initialize') {
      pending = pending.then(() => track(post(message)));
    } else {
      void pending.then(() => track(post(message)));
    }
  }
});
// Requests still in flight when stdin closes are answered before shutdown.
const inFlight = new Set();
function track(promise) {
  inFlight.add(promise);
  void promise.finally(() => inFlight.delete(promise));
  return promise;
}
process.stdin.on('end', () => {
  void pending
    .then(() => Promise.allSettled(Array.from(inFlight)))
    .then(shutdown);
});
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
