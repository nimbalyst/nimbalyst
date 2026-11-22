// @vitest-environment node
/**
 * The local server's Teams tools that do not need a wiki: `openUrl` opens only
 * console pages, and `teamSignIn` answers pending until the device flow is
 * approved, then signedIn, without a second approval on the next call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { saveCredentials } from '../../cloud/credentials.js';
import { teamTools } from '../teamTools.js';
import type { LocalWikiContext } from '../localTools.js';

const noWiki = { open: async () => Promise.reject(new Error('no wiki')), init: async () => Promise.reject(new Error('no wiki')) } as unknown as LocalWikiContext;
const text = (result: { content: { text: string }[] }) => result.content[0]!.text;

let tmp: string;
const savedEnv = { ...process.env };
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'nim-team-tools-'));
  process.env.NIM_CONFIG_DIR = tmp;
  process.env.NIM_SERVER = 'https://sync.test';
});
afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(tmp, { recursive: true, force: true });
});

function tools(options: Parameters<typeof teamTools>[1] = {}) {
  return new Map(teamTools(noWiki, options).map((tool) => [tool.definition.name, tool]));
}

describe('openUrl', () => {
  it('opens console pages and refuses every other origin', async () => {
    const opened: string[] = [];
    const openUrl = tools({ openUrl: (url) => opened.push(url) }).get('openUrl')!;
    const home = 'https://console.nimbalyst.com/org/o1/project/p1/document/d1';
    expect((await openUrl.call({ url: home })).isError).toBeUndefined();
    for (const url of [
      'http://console.nimbalyst.com/org/o1',
      'https://console.nimbalyst.com.evil.test/org/o1',
      'https://evil.test/?https://console.nimbalyst.com/',
      'https://user@console.nimbalyst.com/org/o1',
      'https://console.nimbalyst.com:8443/org/o1',
      'https://console.nimbalyst.com/org/o1?a=1&calc',
      'file:///etc/passwd',
      'javascript:alert(1)',
      '',
    ]) {
      const result = await openUrl.call({ url });
      expect(result.isError, url).toBe(true);
    }
    expect(opened).toEqual([home]);
  });
});

describe('teamSignIn', () => {
  it('returns the code while pending, signedIn once approved, and needs no new approval after', async () => {
    const opened: string[] = [];
    let approve!: () => void;
    let logins = 0;
    const deviceLogin = (async (server: string, onPrompt: (code: string, uri: string, complete?: string) => void) => {
      logins++;
      onPrompt('ABCD-EFGH', 'https://console.nimbalyst.com/device', 'https://console.nimbalyst.com/device?code=ABCD-EFGH');
      await new Promise<void>((resolve) => (approve = resolve));
      const creds = { accessToken: 'at', refreshToken: 'rt' };
      await saveCredentials(server, creds);
      return creds;
    }) as any;
    const signIn = tools({ openUrl: (url) => opened.push(url), deviceLogin, userInfo: async () => ({ sub: 'u1', email: 'kim@example.com' }), pollWaitMs: 10 }).get('teamSignIn')!;

    const first = JSON.parse(text(await signIn.call({})));
    expect(first).toMatchObject({ state: 'pending', userCode: 'ABCD-EFGH', verificationUrl: 'https://console.nimbalyst.com/device?code=ABCD-EFGH' });
    expect(opened).toEqual(['https://console.nimbalyst.com/device?code=ABCD-EFGH']);
    expect(JSON.parse(text(await signIn.call({})))).toMatchObject({ state: 'pending', userCode: 'ABCD-EFGH' });

    approve();
    expect(JSON.parse(text(await signIn.call({})))).toEqual({ state: 'signedIn', server: 'https://sync.test', email: 'kim@example.com' });
    // Stored where `nim login` keeps it; a later call reuses it.
    expect(JSON.parse(text(await signIn.call({})))).toMatchObject({ state: 'signedIn' });
    expect(logins).toBe(1);
  });

  it('finishes the approved code from a new server process instead of starting a new one', async () => {
    // Hosts that start each turn fresh relaunch `nim mcp`, so the call that
    // finishes a sign-in can land in a different process from the one that
    // started it; before the fix every call minted a new code and none completed.
    process.env.NIM_DEVICE_POLL_FLOOR_MS = '0';
    let approved = false;
    const codeRequests: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === 'https://sync.test/oauth/device/code') {
        codeRequests.push(url);
        return json({
          device_code: `dev-${codeRequests.length}`, user_code: `CODE-000${codeRequests.length}`,
          verification_uri: 'https://console.nimbalyst.com/connect/device',
          verification_uri_complete: `https://console.nimbalyst.com/connect/device?user_code=CODE-000${codeRequests.length}`,
          interval: 0, expires_in: 900,
        });
      }
      if (url === 'https://sync.test/oauth/token') {
        const deviceCode = new URLSearchParams(String(init?.body)).get('device_code');
        if (deviceCode !== 'dev-1') return json({ error: 'invalid_grant' }, 400);
        return approved ? json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }) : json({ error: 'authorization_pending' }, 400);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const opened: string[] = [];
    const options = { openUrl: (url: string) => opened.push(url), userInfo: async () => ({ sub: 'u1', email: 'kim@example.com' }), pollWaitMs: 50 };

    const firstProcess = tools(options).get('teamSignIn')!;
    expect(JSON.parse(text(await firstProcess.call({})))).toMatchObject({ state: 'pending', userCode: 'CODE-0001' });

    const secondProcess = tools(options).get('teamSignIn')!;
    expect(JSON.parse(text(await secondProcess.call({})))).toMatchObject({ state: 'pending', userCode: 'CODE-0001' });
    approved = true;
    expect(JSON.parse(text(await secondProcess.call({})))).toEqual({ state: 'signedIn', server: 'https://sync.test', email: 'kim@example.com' });

    expect(codeRequests).toHaveLength(1);
    expect(opened).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
