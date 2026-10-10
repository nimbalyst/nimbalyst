// @vitest-environment node
/**
 * Link preview fetching in main: metadata parsing with its fallbacks, and the
 * request limits (public addresses only, pinned per connection and per
 * redirect; size cap; one deadline; bounded concurrency).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn() } } }));

import { parseLinkPreviewHtml } from '../linkPreviewMetadata';
import { createRequestLimiter, fetchLinkPreviewUncached, isNonPublicAddress, type LinkPreviewDeps } from '../LinkPreviewService';

describe('parseLinkPreviewHtml', () => {
  it('prefers Open Graph, resolves relative URLs and decodes entities', () => {
    const html = `<!doctype html><html><head>
      <title>Plain title</title>
      <meta property="og:title" content="Q3 &amp; beyond &#8212; plan">
      <meta name="description" content="fallback description">
      <meta property='og:description' content='The real one'>
      <meta property="og:site_name" content="Example">
      <meta property="og:image" content="/img/card.png">
      <link rel="apple-touch-icon" href="/touch.png"><link rel="shortcut icon" href="favicon-32.png">
    </head><body><meta property="og:title" content="ignored, in body"></body></html>`;
    expect(parseLinkPreviewHtml(html, 'https://example.com/a/b', 'https://www.example.com/a/b')).toEqual({
      url: 'https://example.com/a/b',
      finalUrl: 'https://www.example.com/a/b',
      title: 'Q3 & beyond — plan',
      description: 'The real one',
      siteName: 'Example',
      favicon: 'https://www.example.com/a/favicon-32.png',
    });
  });

  it('parses a hostile 512 KB head in bounded time', () => {
    // A long attribute name with no '=' backtracks a regex attribute scanner;
    // many unclosed tags followed by one '>' backtrack a `[^>]*>` tag scanner.
    const hostile = '<head><meta ' + 'a'.repeat(40_000) + '>' + '<meta content="'.repeat(30_000) + '>' + '<title>' + 'x'.repeat(40_000);
    expect(hostile.length).toBeGreaterThan(512 * 1024);
    const started = performance.now();
    parseLinkPreviewHtml(hostile, 'https://example.com/');
    expect(performance.now() - started).toBeLessThan(100);
  });

  it('falls back to twitter tags, then <title>, and to /favicon.ico; drops non-http images', () => {
    const html = `<head><meta name="twitter:description" content="tw desc"><meta name="twitter:image" content="javascript:alert(1)"><title>
      Just a   title</title></head>`;
    expect(parseLinkPreviewHtml(html, 'https://example.com/x')).toEqual({
      url: 'https://example.com/x',
      title: 'Just a title',
      description: 'tw desc',
      favicon: 'https://example.com/favicon.ico',
    });
  });
});

interface Seen { host?: string; cookie?: string; authorization?: string }

/** A local server standing in for "a public site"; the tests allow only its address. */
async function withServer(routes: Record<string, (res: ServerResponse) => void>, run: (port: number, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({ host: req.headers.host, cookie: req.headers.cookie, authorization: req.headers.authorization });
    const route = routes[req.url ?? '/'];
    if (route) route(res);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run((server.address() as AddressInfo).port, seen);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function html(body: string) {
  return (res: ServerResponse) => { res.setHeader('content-type', 'text/html'); res.end(body); };
}

/** Resolves every name to the local server; only that address is "public". */
function localDeps(hosts: Record<string, string[]> = {}): LinkPreviewDeps & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    resolveHost: async (host) => {
      lookups.push(host);
      return hosts[host] ?? ['127.0.0.1'];
    },
    isAllowedAddress: (address) => address === '127.0.0.1',
  };
}

describe('isNonPublicAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '255.255.255.255', '224.0.0.1', '198.18.0.1',
    '::', '::1', '::ffff:7f00:1', '::ffff:127.0.0.1', '::7f00:1', '64:ff9b::a00:1', '64:ff9b:1::1', '2002:7f00:1::1', '2001:db8::1',
    'fc00::1', 'fd12::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001::1', 'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isNonPublicAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '2606:4700:4700::1111', '64:ff9b::5db8:d822'])('allows %s', (address) => {
    expect(isNonPublicAddress(address)).toBe(false);
  });
});

describe('fetchLinkPreviewUncached', () => {
  it('refuses a mapped-IPv6 loopback literal', async () => {
    await expect(fetchLinkPreviewUncached('http://[::ffff:127.0.0.1]:1/')).rejects.toThrow(/public/);
  });

  it('connects to the address it validated (one lookup per connection), keeps the Host header, sends no credentials', async () => {
    await withServer({ '/': html('<title>Hello</title>') }, async (port, seen) => {
      const deps = localDeps();
      let calls = 0;
      // Rebinding: a second resolution would return a private address.
      deps.resolveHost = async (host) => { deps.lookups.push(host); calls += 1; return calls === 1 ? ['127.0.0.1'] : ['10.0.0.1']; };
      const result = await fetchLinkPreviewUncached(`http://site.test:${port}/`, deps);
      expect(result.title).toBe('Hello');
      // One lookup for the page connection. The favicon is a new connection
      // with its own lookup, which now answers private, so it never connects.
      expect(deps.lookups).toEqual(['site.test', 'site.test']);
      expect(seen).toEqual([{ host: `site.test:${port}`, cookie: undefined, authorization: undefined }]);
      expect(result.favicon).toBeUndefined();
    });
  });

  it('refuses a redirect to a private address', async () => {
    await withServer({ '/': (res) => { res.statusCode = 302; res.setHeader('location', '/next'); res.end(); }, '/next': (res) => { res.statusCode = 302; res.setHeader('location', 'http://intranet.test/'); res.end(); } }, async (port) => {
      await expect(fetchLinkPreviewUncached(`http://site.test:${port}/`, localDeps({ 'intranet.test': ['10.0.0.5'] }))).rejects.toThrow(/public/);
    });
  });

  it('reads at most maxBytes of the body', async () => {
    const head = '<title>Capped</title>';
    await withServer({ '/': html(head + 'x'.repeat(200_000) + '<meta property="og:title" content="past the cap">') }, async (port) => {
      const result = await fetchLinkPreviewUncached(`http://site.test:${port}/`, localDeps(), { maxBytes: head.length + 10 });
      expect(result.title).toBe('Capped');
    });
  });

  it('one deadline covers DNS too', async () => {
    const deps = localDeps();
    deps.resolveHost = () => new Promise(() => undefined);
    const started = Date.now();
    await expect(fetchLinkPreviewUncached('https://slow.test/', deps, { timeoutMs: 50 })).rejects.toThrow('Timed out');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('hands the renderer the favicon as a data: URL, and drops one on a private host', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await withServer({
      '/': html('<head><title>T</title><link rel="icon" href="/icon.png"><meta property="og:image" content="http://10.0.0.9/x.png"></head>'),
      '/private': html('<head><title>T</title><link rel="icon" href="http://intranet.test/icon.png"></head>'),
      '/icon.png': (res) => { res.setHeader('content-type', 'image/png'); res.end(png); },
    }, async (port) => {
      const result = await fetchLinkPreviewUncached(`http://site.test:${port}/`, localDeps({ 'intranet.test': ['10.0.0.5'] }));
      expect(result.favicon).toBe(`data:image/png;base64,${png.toString('base64')}`);
      expect(result.image).toBeUndefined();
      const privateIcon = await fetchLinkPreviewUncached(`http://site.test:${port}/private`, localDeps({ 'intranet.test': ['10.0.0.5'] }));
      expect(privateIcon.favicon).toBeUndefined();
    });
  });

  it('rejects non-http schemes before any lookup', async () => {
    const deps = localDeps();
    await expect(fetchLinkPreviewUncached('file:///etc/passwd', deps)).rejects.toThrow(/http/);
    expect(deps.lookups).toEqual([]);
  });
});

describe('createRequestLimiter', () => {
  it('runs at most N requests at once', async () => {
    const limit = createRequestLimiter(2);
    let active = 0;
    let peak = 0;
    const task = () => limit(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });
});
