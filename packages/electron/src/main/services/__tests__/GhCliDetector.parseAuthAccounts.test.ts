// @vitest-environment node
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GhCliDetector, parseAuthAccounts } from '../GhCliDetector';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));

describe('parseAuthAccounts', () => {
  it('parses multiple accounts and marks the active one', () => {
    const text = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token scopes: 'repo'

  ✓ Logged in to github.com account work-emu (keyring)
  - Active account: false
  - Git operations protocol: https`;
    const accounts = parseAuthAccounts(text);
    expect(accounts).toEqual([
      { host: 'github.com', login: 'octocat', active: true },
      { host: 'github.com', login: 'work-emu', active: false },
    ]);
  });

  it('treats a lone account as active when there is no Active-account line (legacy gh)', () => {
    const text = 'Logged in to github.com as octocat (oauth_token)';
    expect(parseAuthAccounts(text)).toEqual([{ host: 'github.com', login: 'octocat', active: true }]);
  });

  it('parses GitHub Enterprise hosts', () => {
    const text = `  ✓ Logged in to ghe.example.com account devuser (keyring)
  - Active account: true`;
    expect(parseAuthAccounts(text)).toEqual([
      { host: 'ghe.example.com', login: 'devuser', active: true },
    ]);
  });

  it('returns an empty array when not logged in', () => {
    expect(parseAuthAccounts('You are not logged into any GitHub hosts.')).toEqual([]);
  });
});

/**
 * `gh auth status` checks tokens over the network; on WSL it can outlast the
 * spawn timeout. A timeout is not an answer, and the PR panel's concurrent
 * status requests should not each spawn gh.
 */
describe('GhCliDetector.getStatus with a slow gh', () => {
  let dir: string;
  let callLog: string;
  let slowFlag: string;
  const previousGhPath = process.env.NIMBALYST_GH_PATH;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-stub-'));
    callLog = path.join(dir, 'calls.log');
    slowFlag = path.join(dir, 'slow');
    const stub = path.join(dir, 'gh');
    fs.writeFileSync(stub, [
      '#!/bin/sh',
      `echo "$*" >> '${callLog}'`,
      'if [ "$1" = "--version" ]; then echo "gh version 2.60.0 (2026-01-01)"; exit 0; fi',
      `if [ -f '${slowFlag}' ]; then exec sleep 5; fi`,
      'echo "github.com"',
      'echo "  ✓ Logged in to github.com account octocat (keyring)"',
      'echo "  - Active account: true"',
    ].join('\n'), { mode: 0o755 });
    process.env.NIMBALYST_GH_PATH = stub;
  });

  afterEach(() => {
    if (previousGhPath === undefined) delete process.env.NIMBALYST_GH_PATH;
    else process.env.NIMBALYST_GH_PATH = previousGhPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const authCalls = () =>
    fs.readFileSync(callLog, 'utf8').split('\n').filter((line) => line.startsWith('auth')).length;

  it('shares one probe between concurrent callers', async () => {
    const detector = new GhCliDetector();
    const [first, second] = await Promise.all([detector.getStatus(), detector.getStatus()]);
    expect(first).toBe(second);
    expect(first).toMatchObject({ installed: true, authed: true, user: 'octocat' });
    expect(authCalls()).toBe(1);
  });

  it('keeps the last login when gh auth status times out', async () => {
    const detector = new GhCliDetector({ cacheMs: 0, timedOutCacheMs: 0, spawnTimeoutMs: 500 });
    expect((await detector.getStatus()).authed).toBe(true);

    fs.writeFileSync(slowFlag, '');
    expect(await detector.getStatus()).toMatchObject({ installed: true, authed: true, user: 'octocat' });
    expect(authCalls()).toBe(2);
  });

  it('reports not signed in when the first probe times out', async () => {
    fs.writeFileSync(slowFlag, '');
    const detector = new GhCliDetector({ spawnTimeoutMs: 500 });
    expect(await detector.getStatus()).toMatchObject({ installed: true, authed: false });
  });
});
