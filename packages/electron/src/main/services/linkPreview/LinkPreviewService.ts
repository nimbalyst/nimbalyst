/**
 * Fetches preview metadata for a web link the user put in a page. Runs in
 * main so the renderer never makes the request, and so the request carries
 * none of the app's cookies or credentials: Node's http client has no cookie
 * jar and we send no auth headers.
 *
 * Limits on every request:
 * - http(s) only, no userinfo in the URL;
 * - every address a host resolves to must be public (`isNonPublicAddress`
 *   classifies the binary address, so IPv4-mapped/compatible IPv6, NAT64 and
 *   6to4 forms of a private IPv4 address are refused too);
 * - the connection is pinned to the address that was validated: the request's
 *   `lookup` hands back that address instead of resolving again, so a DNS
 *   answer cannot change between the check and the connect (rebinding). Host
 *   header, SNI and certificate checks still use the hostname;
 * - the same holds on every redirect hop (at most `MAX_REDIRECTS`);
 * - one deadline (`TIMEOUT_MS`) covers DNS, connect and every hop;
 * - at most `MAX_BYTES` of the page is read; at most `MAX_CONCURRENT` fetches
 *   run at once.
 *
 * The favicon is fetched through the same path (image types only, small cap)
 * and handed to the renderer as a `data:` URL, so the renderer never loads a
 * URL a page chose. Page images (`og:image`) are not used.
 *
 * Results (including failures, for a shorter time) are cached in memory and
 * in a small JSON file under userData so reopening a page does not refetch.
 */

import { app } from 'electron';
import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { logger } from '../../utils/logger';
import { parseLinkPreviewHtml, type LinkPreviewMetadata } from './linkPreviewMetadata';

export const TIMEOUT_MS = 8_000;
export const MAX_BYTES = 512 * 1024;
const FAVICON_TIMEOUT_MS = 3_000;
const FAVICON_MAX_BYTES = 64 * 1024;
const FAVICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon']);
const MAX_REDIRECTS = 5;
const MAX_CONCURRENT = 4;
const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const CACHE_FILE = 'link-preview-cache.json';
const USER_AGENT = 'Mozilla/5.0 (compatible; NimbalystLinkPreview/1.0)';

export interface LinkPreviewDeps {
  resolveHost: (hostname: string) => Promise<string[]>;
  /** Tests narrow this to a local server; production uses `!isNonPublicAddress`. */
  isAllowedAddress?: (address: string) => boolean;
}

const defaultDeps: LinkPreviewDeps = {
  resolveHost: async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address),
};

// ---------------------------------------------------------------------------
// Address classification

function parseIPv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split('.').map(Number);
}

/** 16 bytes, or null. Handles `::` compression, a trailing dotted quad and a zone id. */
function parseIPv6(address: string): number[] | null {
  const plain = address.split('%')[0];
  if (isIP(plain) !== 6) return null;
  let text = plain;
  let tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    tail = parseIPv4(dotted[1]) ?? [];
    text = `${text.slice(0, -dotted[1].length)}0:0`;
  }
  const [left, right] = text.includes('::') ? text.split('::') : [text, null];
  const leftGroups = left ? left.split(':') : [];
  const rightGroups = right ? right.split(':') : [];
  const missing = 8 - leftGroups.length - rightGroups.length;
  const groups = [...leftGroups, ...new Array<string>(right === null ? 0 : missing).fill('0'), ...rightGroups];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    const value = parseInt(group || '0', 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

function isNonPublicIPv4([a, b, c]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

const zero = (bytes: number[], from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);

/**
 * True for any address a page link must not reach: loopback, private,
 * link-local, CGNAT, multicast, unspecified, reserved, documentation, and any
 * IPv6 form that embeds one of those IPv4 addresses. Unparseable is refused.
 */
export function isNonPublicAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) return isNonPublicIPv4(v4);
  const v6 = parseIPv6(address);
  if (!v6) return true;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, which also covers :: and ::1).
  if (zero(v6, 0, 10) && ((v6[10] === 0xff && v6[11] === 0xff) || (v6[10] === 0 && v6[11] === 0))) {
    return isNonPublicIPv4(v6.slice(12));
  }
  // NAT64 well-known prefix 64:ff9b::/96 carries an IPv4 address.
  if (v6[0] === 0x00 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b && zero(v6, 4, 12)) {
    return isNonPublicIPv4(v6.slice(12));
  }
  // 6to4 2002::/16 carries an IPv4 address in bytes 2-5.
  if (v6[0] === 0x20 && v6[1] === 0x02) return isNonPublicIPv4(v6.slice(2, 6));
  // Only global unicast (2000::/3) is public; this excludes fc00::/7, fe80::/10,
  // fec0::/10, ff00::/8, 64:ff9b:1::/48 and the rest of the reserved space.
  if ((v6[0] & 0xe0) !== 0x20) return true;
  // 2001::/23 (Teredo, benchmarking, ORCHID...) and 2001:db8::/32 documentation.
  if (v6[0] === 0x20 && v6[1] === 0x01 && (v6[2] === 0x00 && v6[3] < 0x02)) return true;
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8) return true;
  // 3fff::/20 documentation.
  if (v6[0] === 0x3f && v6[1] === 0xff && v6[2] < 0x10) return true;
  return false;
}

// ---------------------------------------------------------------------------
// One hop, pinned to a validated address

interface Target {
  url: URL;
  address: string;
  family: 4 | 6;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function resolveTarget(raw: string, deps: LinkPreviewDeps, signal: AbortSignal): Promise<Target> {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http(s) links have previews');
  if (url.username || url.password) throw new Error('Links with credentials are not fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Local hosts are not fetched');
  }
  const allowed = deps.isAllowedAddress ?? ((address: string) => !isNonPublicAddress(address));
  const addresses = isIP(host) ? [host] : await abortable(deps.resolveHost(host), signal);
  if (addresses.length === 0 || !addresses.every(allowed)) throw new Error('Host is not a public address');
  const address = addresses[0];
  return { url, address, family: isIP(address) === 6 ? 6 : 4 };
}

interface HopResponse {
  status: number;
  location: string | null;
  contentType: string;
  body: Buffer;
}

function requestPinned(target: Target, signal: AbortSignal, maxBytes: number, accept: string): Promise<HopResponse> {
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) {
      (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  };
  const client = target.url.protocol === 'https:' ? https : http;
  return new Promise<HopResponse>((resolve, reject) => {
    const request = client.request(target.url, {
      method: 'GET',
      agent: false,
      lookup: pinnedLookup,
      signal,
      headers: { 'user-agent': USER_AGENT, accept },
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = typeof response.headers.location === 'string' ? response.headers.location : null;
      const contentType = String(response.headers['content-type'] ?? '');
      if ((status >= 300 && status < 400) || status < 200 || status >= 300) {
        response.resume();
        resolve({ status, location, contentType, body: Buffer.alloc(0) });
        request.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const finish = () => resolve({ status, location, contentType, body: Buffer.concat(chunks) });
      response.on('data', (chunk: Buffer) => {
        const room = maxBytes - total;
        if (room <= 0) return;
        chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        total += Math.min(chunk.length, room);
        if (total >= maxBytes) {
          finish();
          request.destroy();
        }
      });
      response.on('end', finish);
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

/** Follow redirects, validating and pinning every hop, under the caller's signal. */
async function fetchPinned(
  rawUrl: string,
  deps: LinkPreviewDeps,
  signal: AbortSignal,
  maxBytes: number,
  accept: string,
): Promise<{ finalUrl: string; contentType: string; body: Buffer }> {
  let current = rawUrl;
  for (let hop = 0; ; hop += 1) {
    const target = await resolveTarget(current, deps, signal);
    const response = await requestPinned(target, signal, maxBytes, accept);
    if (response.status >= 300 && response.status < 400) {
      if (!response.location || hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
      current = new URL(response.location, target.url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return { finalUrl: target.url.toString(), contentType: response.contentType, body: response.body };
  }
}

async function withDeadline<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFaviconDataUrl(url: string, deps: LinkPreviewDeps): Promise<string | undefined> {
  try {
    return await withDeadline(FAVICON_TIMEOUT_MS, async (signal) => {
      const { contentType, body } = await fetchPinned(url, deps, signal, FAVICON_MAX_BYTES + 1, 'image/*');
      const type = contentType.split(';')[0].trim().toLowerCase();
      if (!FAVICON_TYPES.has(type) || body.length === 0 || body.length > FAVICON_MAX_BYTES) return undefined;
      return `data:${type};base64,${body.toString('base64')}`;
    });
  } catch {
    return undefined;
  }
}

/** One uncached fetch. Throws on refusal, timeout or a non-2xx answer. */
export async function fetchLinkPreviewUncached(
  rawUrl: string,
  deps: LinkPreviewDeps = defaultDeps,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<LinkPreviewMetadata> {
  const page = await withDeadline(options.timeoutMs ?? TIMEOUT_MS, (signal) =>
    fetchPinned(rawUrl, deps, signal, options.maxBytes ?? MAX_BYTES, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'));
  const finalUrl = page.finalUrl;
  if (!/html|xml/i.test(page.contentType)) {
    // A file link: the card shows the file name and site.
    const parsed = new URL(finalUrl);
    let name = parsed.hostname;
    try {
      name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '') || parsed.hostname;
    } catch {
      // Malformed escape: keep the hostname.
    }
    return { url: rawUrl, ...(finalUrl !== rawUrl ? { finalUrl } : {}), title: name };
  }
  const metadata = parseLinkPreviewHtml(new TextDecoder('utf-8', { fatal: false }).decode(page.body), rawUrl, finalUrl);
  const favicon = metadata.favicon ? await fetchFaviconDataUrl(metadata.favicon, deps) : undefined;
  delete metadata.favicon;
  delete metadata.image;
  return favicon ? { ...metadata, favicon } : metadata;
}

/** At most `limit` tasks in flight; the rest wait in order. */
export function createRequestLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

interface CacheEntry {
  at: number;
  data: LinkPreviewMetadata | null;
}

class LinkPreviewService {
  private entries = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<LinkPreviewMetadata | null>>();
  private loaded: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private limit = createRequestLimiter(MAX_CONCURRENT);

  // Resolved on first use: app.getPath() is not ready at import time.
  private get cachePath(): string {
    return path.join(app.getPath('userData'), CACHE_FILE);
  }

  private load(): Promise<void> {
    this.loaded ??= fs.readFile(this.cachePath, 'utf8').then((text) => {
      const parsed = JSON.parse(text) as Record<string, CacheEntry>;
      for (const [url, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry.at !== 'number') continue;
        // Entries written before favicons were proxied may hold page URLs; drop them.
        if (entry.data && (entry.data.image || (entry.data.favicon && !entry.data.favicon.startsWith('data:')))) continue;
        this.entries.set(url, entry);
      }
    }).catch(() => undefined);
    return this.loaded;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const object = Object.fromEntries(this.entries);
      fs.writeFile(this.cachePath, JSON.stringify(object), 'utf8').catch((error) => {
        logger.main.warn('[LinkPreviewService] could not write cache', error);
      });
    }, 2_000);
  }

  private remember(url: string, data: LinkPreviewMetadata | null): void {
    this.entries.delete(url);
    this.entries.set(url, { at: Date.now(), data });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.scheduleSave();
  }

  async get(url: string): Promise<LinkPreviewMetadata | null> {
    await this.load();
    const cached = this.entries.get(url);
    if (cached && Date.now() - cached.at < (cached.data ? SUCCESS_TTL_MS : FAILURE_TTL_MS)) return cached.data;
    const pending = this.inFlight.get(url);
    if (pending) return pending;
    const request = this.limit(() => fetchLinkPreviewUncached(url))
      .catch((error: unknown) => {
        logger.main.info(`[LinkPreviewService] no preview for ${url}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })
      .then((data) => {
        this.remember(url, data);
        return data;
      })
      .finally(() => this.inFlight.delete(url));
    this.inFlight.set(url, request);
    return request;
  }
}

let instance: LinkPreviewService | null = null;

export function getLinkPreviewService(): LinkPreviewService {
  instance ??= new LinkPreviewService();
  return instance;
}
