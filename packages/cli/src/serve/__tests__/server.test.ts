// @vitest-environment node
/**
 * `nim wiki serve` over a real temp wiki: the token gate, a REST round trip,
 * the stale-write conflict, and a change event after an outside edit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { initWiki, openWiki, type LocalWiki } from '@nimbalyst/local-wiki';
import { startWikiServer, type WikiServer } from '../server.js';
import { parseArgs } from '../../cli/parse.js';
import { wantsOpen } from '../runWikiServe.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(): Promise<{ root: string; wiki: LocalWiki; server: WikiServer }> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nim-serve-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, '.assets');
  mkdirSync(assets);
  writeFileSync(path.join(assets, 'index.html'), '<!doctype html><title>wiki</title>');
  await initWiki(path.join(root, 'wiki'));
  const wiki = await openWiki(path.join(root, 'wiki'), { debounceMs: 20 });
  cleanups.push(() => wiki.close());
  const server = await startWikiServer({ wiki, assetsDir: assets, version: 'test' });
  cleanups.push(() => server.close());
  return { root, wiki, server };
}

/** `fetch` will not send a custom Host header; plain http will. */
function rawStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/snapshot', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('nim wiki serve', () => {
  it('opens the browser for a person at a terminal, not for scripts or over SSH', () => {
    const args = (...flags: string[]) => parseArgs(['wiki', 'serve', ...flags]);
    expect(wantsOpen(args(), {}, true)).toBe(true);
    expect(wantsOpen(args('--no-open'), {}, true)).toBe(false);
    expect(wantsOpen(args(), {}, false)).toBe(false);
    expect(wantsOpen(args(), { SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' }, true)).toBe(false);
    expect(wantsOpen(args('--open'), { SSH_CONNECTION: 'x' }, false)).toBe(true);
    // A boolean flag never swallows the next argument.
    expect(parseArgs(['wiki', 'serve', '--no-open', '--port', '0']).flags.port).toBe('0');
  });

  it('refuses requests without the token and trades the URL token for a cookie', async () => {
    const { server } = await serve();
    expect((await fetch(`${server.origin}/api/snapshot`)).status).toBe(401);
    expect((await fetch(`${server.origin}/`)).status).toBe(401);
    expect((await fetch(`${server.origin}/api/snapshot`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);

    const first = await fetch(server.url, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/');
    const cookie = first.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toBe(`nim_wiki_${server.port}=${server.token}`);

    const page = await fetch(`${server.origin}/some/app/route`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>wiki</title>');

    // A page on another site cannot ride the cookie, and a rebinding Host is refused.
    expect((await fetch(`${server.origin}/api/snapshot`, { headers: { cookie, origin: 'https://evil.example' } })).status).toBe(403);
    expect(await rawStatus(server.port, { cookie, host: `evil.example:${server.port}` })).toBe(421);
  });

  it('creates, reads and writes a page through REST, and rejects a stale write with 409', async () => {
    const { root, server } = await serve();
    const auth = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
    const call = async (method: string, route: string, body?: unknown) => {
      const res = await fetch(`${server.origin}${route}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };

    const created = await call('POST', '/api/command', { type: 'register-document', title: 'Acme', parentFolderId: null, body: 'Hello\n' });
    expect(created.status).toBe(200);
    const id = created.json.id as string;
    const snapshot = await call('GET', '/api/snapshot');
    expect(snapshot.json.items.map((d: { title: string }) => d.title)).toEqual(['Acme']);

    const read = await call('GET', `/api/pages/${id}/body`);
    expect(read.json.markdown).toBe('Hello\n');
    const written = await call('PUT', `/api/pages/${id}/body`, { markdown: 'Edited\n', expectedVersion: read.json.version });
    expect(written.status).toBe(200);
    expect(readFileSync(path.join(root, 'wiki', 'Acme.md'), 'utf8')).toMatch(/^---\nid: .*---\nEdited\n$/s);

    // A write based on the old version loses and gets the current text back.
    const stale = await call('PUT', `/api/pages/${id}/body`, { markdown: 'Lost\n', expectedVersion: read.json.version });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ ok: false, reason: 'conflict', currentVersion: written.json.version, markdown: 'Edited\n' });
    expect(readFileSync(path.join(root, 'wiki', 'Acme.md'), 'utf8')).not.toContain('Lost');

    expect((await call('GET', '/api/search?q=edited')).json.hits[0]).toMatchObject({ id, title: 'Acme' });
    expect((await call('GET', '/api/pages/nope/body')).status).toBe(404);
  });

  it('streams a change event when a page file is edited outside the server', async () => {
    const { root, server } = await serve();
    const res = await fetch(`${server.origin}/api/events`, { headers: { Authorization: `Bearer ${server.token}` } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const nextEvent = async (name: string) => {
      for (;;) {
        const frames = buffer.split('\n\n');
        buffer = frames.pop()!;
        const hit = frames.find((frame) => frame.includes(`event: ${name}\n`));
        if (hit) return JSON.parse(hit.slice(hit.indexOf('data: ') + 6));
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += value;
      }
    };
    await nextEvent('ready');

    writeFileSync(path.join(root, 'wiki', 'Outside.md'), '---\nid: 01J9Z3K6V4C2W8N5QX7R1T0BHM\n---\nWritten by an editor\n');
    const change = await nextEvent('change');
    expect(change.changedIds).toContain('01J9Z3K6V4C2W8N5QX7R1T0BHM');
    await reader.cancel();
  });
});
