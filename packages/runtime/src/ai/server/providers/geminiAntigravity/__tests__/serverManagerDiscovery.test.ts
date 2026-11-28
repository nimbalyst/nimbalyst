// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityServerManager, type AntigravityEndpoint } from '../AntigravityServerManager';

type TestableAntigravityServerManager = {
  discoverRunningHub: () => Promise<AntigravityEndpoint | null>;
  discoverDaemonHub: (daemonDir?: string) => Promise<AntigravityEndpoint | null>;
  isPidAlive: (pid: number) => boolean;
  isHealthy: (endpoint: AntigravityEndpoint) => Promise<boolean>;
  runCommand: (executable: string, args: readonly string[]) => Promise<string>;
  runPowerShell: (script: string) => Promise<string>;
};

function freshManager(): AntigravityServerManager {
  (AntigravityServerManager as unknown as { instance: unknown }).instance = null;
  return AntigravityServerManager.shared();
}

function testable(manager: AntigravityServerManager): TestableAntigravityServerManager {
  return manager as unknown as TestableAntigravityServerManager;
}

afterEach(() => vi.restoreAllMocks());

describe('AntigravityServerManager running hub discovery', () => {
  it('attaches to a healthy hub via ~/.gemini/antigravity/daemon/hub_*.json and skips dead PIDs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-daemon-test-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'hub_dead.json'),
        JSON.stringify({ pid: 99991, httpsPort: 51717, csrfToken: 'stale-csrf' }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'hub_live.json'),
        JSON.stringify({ pid: 40591, httpsPort: 63063, csrfToken: 'daemon-csrf' }),
        'utf8',
      );

      const manager = freshManager();
      const tm = testable(manager);
      vi.spyOn(tm, 'isPidAlive').mockImplementation((pid) => pid === 40591);
      const healthy = vi.spyOn(tm, 'isHealthy').mockResolvedValue(true);

      await expect(tm.discoverDaemonHub(tmpDir)).resolves.toEqual({
        httpsPort: 63063,
        csrf: 'daemon-csrf',
        owned: false,
      });
      expect(healthy).toHaveBeenCalledTimes(1);
      expect(healthy).toHaveBeenCalledWith({
        httpsPort: 63063,
        csrf: 'daemon-csrf',
        owned: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips Nimbalyst owned standalone child PID and port when discovering daemon hubs', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-daemon-self-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'hub_owned_pid.json'),
        JSON.stringify({ pid: 41000, httpsPort: 51717, csrfToken: 'owned-csrf' }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'hub_owned_port.json'),
        JSON.stringify({ pid: 41001, httpsPort: 51718, csrfToken: 'owned-port-csrf' }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'hub_external.json'),
        JSON.stringify({ pid: 42000, httpsPort: 63065, csrfToken: 'ide-csrf' }),
        'utf8',
      );

      const manager = freshManager();
      (manager as unknown as { child: { pid: number; exitCode: number | null } }).child = {
        pid: 41000,
        exitCode: null,
      };
      (manager as unknown as { endpoint: AntigravityEndpoint }).endpoint = {
        httpsPort: 51718,
        csrf: 'owned-port-csrf',
        owned: true,
      };

      const tm = testable(manager);
      vi.spyOn(tm, 'isPidAlive').mockReturnValue(true);
      const healthy = vi.spyOn(tm, 'isHealthy').mockResolvedValue(true);

      await expect(tm.discoverDaemonHub(tmpDir)).resolves.toEqual({
        httpsPort: 63065,
        csrf: 'ide-csrf',
        owned: false,
      });
      expect(healthy).toHaveBeenCalledTimes(1);
      expect(healthy).toHaveBeenCalledWith({
        httpsPort: 63065,
        csrf: 'ide-csrf',
        owned: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // The hub_*.json format has not been checked against every Antigravity
  // build, so a missing directory or a file in an unexpected shape must fall
  // through to the ps/lsof discovery rather than end discovery.
  it.each([
    ['a missing daemon directory', (dir: string) => fs.rmSync(dir, { recursive: true, force: true })],
    ['malformed daemon files', (dir: string) => {
      fs.writeFileSync(path.join(dir, 'hub_bad.json'), '{not json', 'utf8');
      fs.writeFileSync(
        path.join(dir, 'hub_shape.json'),
        JSON.stringify({ port: 63063, token: 'other-shape' }),
        'utf8',
      );
    }],
  ])('falls through to ps/lsof discovery on %s', async (_label, prepare) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-daemon-test-'));
    try {
      prepare(tmpDir);
      const manager = freshManager();
      const tm = testable(manager);
      const realDaemonHub = tm.discoverDaemonHub.bind(manager);
      vi.spyOn(tm, 'discoverDaemonHub').mockImplementation(() => realDaemonHub(tmpDir));
      vi.spyOn(tm, 'runCommand').mockImplementation(async (executable) => {
        if (executable === '/bin/ps') {
          return '45198 /Applications/Antigravity.app/Contents/Resources/bin/language_server ' +
            '--subclient_type hub --csrf_token ps-csrf --app_data_dir antigravity\n';
        }
        if (executable === '/usr/sbin/lsof') return 'p45198\nn127.0.0.1:57964\n';
        throw new Error(`Unexpected executable: ${executable}`);
      });
      vi.spyOn(tm, 'isHealthy').mockResolvedValue(true);

      await expect(tm.discoverRunningHub()).resolves.toEqual({
        httpsPort: 57964,
        csrf: 'ps-csrf',
        owned: false,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('attaches to a healthy macOS IDE hub using its live CSRF token and HTTPS port', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    const manager = freshManager();
    const tm = testable(manager);
    vi.spyOn(tm, 'discoverDaemonHub').mockResolvedValue(null);
    vi.spyOn(tm, 'runCommand').mockImplementation(async (executable) => {
      if (executable === '/bin/ps') {
        return '45198 /Applications/Antigravity.app/Contents/Resources/bin/language_server ' +
          '--standalone --subclient_type hub --https_server_port 0 ' +
          '--csrf_token live-csrf --app_data_dir antigravity\n';
      }
      if (executable === '/usr/sbin/lsof') {
        return 'p45198\nn127.0.0.1:57963\nn127.0.0.1:57964\n';
      }
      throw new Error(`Unexpected executable: ${executable}`);
    });
    const healthy = vi.spyOn(tm, 'isHealthy').mockImplementation(async (endpoint) => (
      endpoint.httpsPort === 57964
    ));

    await expect(tm.discoverRunningHub()).resolves.toEqual({
      httpsPort: 57964,
      csrf: 'live-csrf',
      owned: false,
    });
    expect(healthy).toHaveBeenNthCalledWith(
      1,
      { httpsPort: 57963, csrf: 'live-csrf', owned: false },
    );
    expect(healthy).toHaveBeenNthCalledWith(
      2,
      { httpsPort: 57964, csrf: 'live-csrf', owned: false },
    );
  });

  // The hub listens on both a TLS and a plain-HTTP port, and their numeric
  // order is incidental to the IDE build: observed inverted 2026-09-15, where
  // 1792 spoke plain HTTP and 51717 spoke TLS. Picking the lower port made
  // every RPC fail the TLS handshake, discovery returned null, and Nimbalyst
  // would spawn a second language_server rather than attach to the user's
  // running editor. macOS already probes each listener; Windows must too.
  it('attaches to the Windows hub port that answers, not the lowest-numbered one', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const manager = freshManager();
    const tm = testable(manager);
    vi.spyOn(tm, 'discoverDaemonHub').mockResolvedValue(null);
    vi.spyOn(tm, 'runPowerShell').mockResolvedValue('live-csrf|1792,51717\n');
    const healthy = vi.spyOn(tm, 'isHealthy').mockImplementation(async (endpoint) => (
      endpoint.httpsPort === 51717
    ));

    await expect(tm.discoverRunningHub()).resolves.toEqual({
      httpsPort: 51717,
      csrf: 'live-csrf',
      owned: false,
    });
    expect(healthy).toHaveBeenCalledWith({ httpsPort: 1792, csrf: 'live-csrf', owned: false });
  });

  it('returns null when no Windows hub port answers', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const manager = freshManager();
    const tm = testable(manager);
    vi.spyOn(tm, 'discoverDaemonHub').mockResolvedValue(null);
    vi.spyOn(tm, 'runPowerShell').mockResolvedValue('live-csrf|1792,51717\n');
    vi.spyOn(tm, 'isHealthy').mockResolvedValue(false);

    await expect(tm.discoverRunningHub()).resolves.toBeNull();
  });
});
