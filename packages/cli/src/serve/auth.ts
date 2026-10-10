/**
 * Who may talk to `nim wiki serve`.
 *
 * The server binds to loopback only, but loopback is shared by every local
 * process and every web page the user has open. So each request must carry the
 * random token printed at start: in the URL once (`?token=`, which the server
 * swaps for a cookie and strips from the address bar), then as an HttpOnly
 * SameSite=Strict cookie, or as `Authorization: Bearer` for scripts.
 *
 * Two more checks stop a web page from using the user's browser as a proxy:
 * the Host header must name loopback (DNS rebinding), and a request that names
 * an Origin must come from this server's own origin.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Cookies are not port-scoped, so two servers on one machine need distinct names. */
export function cookieName(port: number): string {
  return `nim_wiki_${port}`;
}

export function sessionCookie(port: number, token: string): string {
  return `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type TokenSource = 'query' | 'cookie' | 'header';

/** Where the request's valid token came from, or null when it has none. */
export function tokenSource(req: IncomingMessage, url: URL, port: number, token: string): TokenSource | null {
  const fromQuery = url.searchParams.get('token');
  if (fromQuery && sameToken(fromQuery, token)) return 'query';
  const fromCookie = parseCookies(req.headers.cookie).get(cookieName(port));
  if (fromCookie && sameToken(fromCookie, token)) return 'cookie';
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && sameToken(auth.slice(7).trim(), token)) return 'header';
  return null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const colon = hostHeader.lastIndexOf(':');
  const name = colon > hostHeader.lastIndexOf(']') ? hostHeader.slice(0, colon) : hostHeader;
  const hostPort = colon > hostHeader.lastIndexOf(']') ? Number(hostHeader.slice(colon + 1)) : 80;
  return LOOPBACK_HOSTS.has(name.toLowerCase()) && hostPort === port;
}

/** A cross-origin request (a page on another site) is refused even with a cookie. */
export function isAllowedOrigin(originHeader: string | undefined, port: number): boolean {
  if (!originHeader) return true;
  try {
    const origin = new URL(originHeader);
    return origin.protocol === 'http:' && isLoopbackHost(origin.host, port);
  } catch {
    return false;
  }
}
