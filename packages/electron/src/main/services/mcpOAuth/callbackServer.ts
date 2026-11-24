/**
 * One-shot loopback listener for the OAuth redirect.
 *
 * Listens on the registered redirect URI's host, port and path. Flow integrity
 * comes from `state` (32 random bytes, compared in constant time, accepted
 * once) and PKCE, not from the path: a stray request to the port has no live
 * `state` and is rejected. When the authorization server advertises RFC 9207
 * support, `iss` is required and must name the pinned issuer.
 */
import * as dns from 'dns';
import * as http from 'http';
import * as os from 'os';
import { timingSafeEqual } from 'crypto';
import { issuersMatch } from './urlPolicy';
import { McpOAuthError } from './types';

export interface CallbackExpectation {
  state: string;
  issuer: string;
  requireIss: boolean;
}

export interface CallbackListener {
  /** The redirect URI with the port actually bound. */
  readonly redirectUri: string;
  readonly port: number;
  expect(expectation: CallbackExpectation): void;
  waitForCode(timeoutMs: number, signal?: AbortSignal): Promise<string>;
  close(): void;
}

const SUCCESS_PAGE = '<!doctype html><meta charset="utf-8"><title>Nimbalyst</title><p>Authorization complete. You can close this window and return to Nimbalyst.</p>';
const FAILURE_PAGE = '<!doctype html><meta charset="utf-8"><title>Nimbalyst</title><p>Authorization did not complete. Return to Nimbalyst for details.</p>';

/**
 * @param portOverride listen on this port instead of the one in the URI (0 for
 *   ephemeral). Only used when a dynamic client is being re-registered.
 */
export async function startCallbackListener(
  redirectUri: string,
  portOverride?: number,
): Promise<CallbackListener> {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    throw new McpOAuthError('invalid_config', 'The OAuth redirect URI is not valid.');
  }
  if (url.protocol !== 'http:') {
    throw new McpOAuthError('invalid_config', 'The OAuth redirect URI must be a loopback http URL.');
  }
  const requestedPort = portOverride ?? (url.port ? Number(url.port) : NaN);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new McpOAuthError('invalid_config', 'The OAuth redirect URI has no usable port.');
  }
  const addresses = await resolveListenAddresses(url.hostname);
  const path = url.pathname || '/';

  let expectation: CallbackExpectation | null = null;
  let consumed = false;
  let settle: ((result: { code?: string; error?: McpOAuthError }) => void) | null = null;
  const pending = new Promise<{ code?: string; error?: McpOAuthError }>((resolve) => {
    settle = resolve;
  });

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    let reqUrl: URL;
    try {
      reqUrl = new URL(req.url ?? '/', 'http://callback.invalid');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (req.method !== 'GET' || reqUrl.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    const params = reqUrl.searchParams;
    const state = params.get('state');
    if (!expectation || consumed || !state || !constantTimeEquals(state, expectation.state)) {
      // Not our flow. Do not settle: a stray or replayed request must not end
      // the real one.
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_PAGE);
      return;
    }
    consumed = true;

    const iss = params.get('iss');
    if (iss !== null || expectation.requireIss) {
      if (iss === null || !issuersMatch(iss, expectation.issuer)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_PAGE);
        settle?.({ error: new McpOAuthError('callback_validation', 'The OAuth callback named a different authorization server.') });
        return;
      }
    }

    const error = params.get('error');
    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_PAGE);
      settle?.({
        error: error === 'access_denied'
          ? new McpOAuthError('provider_rejected', 'The OAuth provider denied access.')
          : new McpOAuthError('provider_rejected', 'The OAuth provider rejected the authorization request.'),
      });
      return;
    }
    const code = params.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(FAILURE_PAGE);
      settle?.({ error: new McpOAuthError('callback_validation', 'The OAuth callback did not include an authorization code.') });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SUCCESS_PAGE);
    settle?.({ code });
  };

  const servers: http.Server[] = [];
  let boundPort = requestedPort;
  try {
    for (let i = 0; i < addresses.length; i += 1) {
      const address = addresses[i];
      const server = http.createServer(handler);
      try {
        boundPort = await listen(server, address, boundPort);
        servers.push(server);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // `localhost` also binds ::1 when the machine has IPv6; its absence is fine.
        if (i > 0 && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) {
          continue;
        }
        if (code === 'EADDRINUSE' || code === 'EACCES') {
          throw new McpOAuthError('port_conflict', 'The OAuth callback port is already in use.');
        }
        throw new McpOAuthError('invalid_config', 'The OAuth callback listener could not start.');
      }
    }
  } catch (error) {
    for (const server of servers) {
      server.close();
    }
    throw error;
  }

  const boundUrl = new URL(url.href);
  if (boundUrl.port !== String(boundPort)) {
    boundUrl.port = String(boundPort);
  }
  const boundRedirectUri = portOverride === undefined && url.port === String(boundPort) ? redirectUri : boundUrl.href;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const server of servers) {
      server.close();
      server.closeAllConnections?.();
    }
  };

  return {
    redirectUri: boundRedirectUri,
    port: boundPort,
    expect(next) {
      expectation = next;
    },
    async waitForCode(timeoutMs, signal) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<{ error: McpOAuthError }>((resolve) => {
        timer = setTimeout(() => resolve({ error: new McpOAuthError('timeout', 'Authorization timed out.') }), timeoutMs);
      });
      const aborted = new Promise<{ error: McpOAuthError }>((resolve) => {
        if (!signal) return;
        if (signal.aborted) resolve({ error: new McpOAuthError('cancelled', 'Authorization was cancelled.') });
        signal.addEventListener('abort', () => resolve({ error: new McpOAuthError('cancelled', 'Authorization was cancelled.') }), { once: true });
      });
      try {
        const result = await Promise.race([pending, timeout, aborted]);
        if ('error' in result && result.error) {
          throw result.error;
        }
        return (result as { code: string }).code;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    close,
  };
}

function listen(server: http.Server, address: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const bound = server.address();
      resolve(typeof bound === 'object' && bound ? bound.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, address);
  });
}

async function resolveListenAddresses(hostname: string): Promise<string[]> {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost') {
    return ['127.0.0.1', '::1'];
  }
  if (bare === '::1') {
    return ['::1'];
  }
  if (/^127\.\d+\.\d+\.\d+$/.test(bare)) {
    return [bare];
  }
  // A custom callback host: bind it only if every address it resolves to
  // belongs to this machine, so the redirect cannot be served to another host.
  let resolved: dns.LookupAddress[];
  try {
    resolved = await dns.promises.lookup(bare, { all: true });
  } catch {
    throw new McpOAuthError('invalid_config', 'The OAuth callback host does not resolve.');
  }
  const local = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      local.add(entry.address.toLowerCase());
    }
  }
  const addresses = resolved.map((entry) => entry.address.toLowerCase());
  if (addresses.length === 0 || !addresses.every((address) => local.has(address))) {
    throw new McpOAuthError('invalid_config', 'The OAuth callback host is not an address on this machine.');
  }
  return Array.from(new Set(addresses));
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
