/**
 * The `nim wiki serve` HTTP server: loopback only, token on every request,
 * static `@nimbalyst/wiki-web` assets, REST over the library, SSE changes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LocalWiki } from '@nimbalyst/local-wiki';
import { isAllowedOrigin, isLoopbackHost, newToken, sessionCookie, tokenSource } from './auth.js';
import { handleApi } from './api.js';
import { ChangeStream } from './events.js';
import { BASE_HEADERS, HttpError, sendError, sendJson } from './http.js';
import { serveStatic } from './static.js';

export interface WikiServerOptions {
  wiki: LocalWiki;
  /** Built wiki-web folder (holds index.html). Null serves the API only. */
  assetsDir: string | null;
  /** 0 picks a free port. */
  port?: number;
  token?: string;
  version?: string;
  projectRoot?: string | null;
}

export interface WikiServer {
  port: number;
  token: string;
  /** Origin without the token. */
  origin: string;
  /** The URL to open: carries the token once, then the cookie takes over. */
  url: string;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

export async function startWikiServer(options: WikiServerOptions): Promise<WikiServer> {
  const token = options.token ?? newToken();
  const events = new ChangeStream(options.wiki);
  const api = { wiki: options.wiki, events, version: options.version ?? '0.0.0', projectRoot: options.projectRoot ?? null };
  let port = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!isLoopbackHost(req.headers.host, port)) return plain(res, 421, 'This server only answers on 127.0.0.1 or localhost.');
    const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);
    if (!isAllowedOrigin(req.headers.origin, port)) return plain(res, 403, 'Cross-origin requests are refused.');
    const source = tokenSource(req, url, port, token);
    if (!source) {
      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 401, { error: { code: 'unauthorized', message: 'Open the URL that nim wiki serve printed; it carries the access token.' } });
      }
      return plain(res, 401, 'Open the URL that `nim wiki serve` printed; it carries the access token.');
    }
    if (source === 'query') {
      // Swap the URL token for a cookie and drop it from the address bar and history.
      url.searchParams.delete('token');
      res.writeHead(302, { ...BASE_HEADERS, 'Set-Cookie': sessionCookie(port, token), Location: url.pathname + url.search });
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (!(await handleApi(api, req, res, url))) throw new HttpError(404, 'no-route', `No route ${req.method} ${url.pathname}`);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'Method not allowed');
    if (!options.assetsDir) return plain(res, 404, 'No browser assets are installed; the API is under /api/.');
    await serveStatic(res, options.assetsDir, url.pathname);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  });
  port = await listen(server, options.port ?? 0);

  const origin = `http://${HOST}:${port}`;
  return {
    port,
    token,
    origin,
    url: `${origin}/?token=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        events.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
