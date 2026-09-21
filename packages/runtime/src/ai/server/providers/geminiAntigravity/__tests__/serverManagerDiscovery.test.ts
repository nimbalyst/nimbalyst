// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityServerManager, type AntigravityEndpoint } from '../AntigravityServerManager';

type TestableAntigravityServerManager = {
  discoverRunningHub: () => Promise<AntigravityEndpoint | null>;
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
  it('attaches to a healthy macOS IDE hub using its live CSRF token and HTTPS port', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    const manager = freshManager();
    const tm = testable(manager);
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
    vi.spyOn(tm, 'runPowerShell').mockResolvedValue('live-csrf|1792,51717\n');
    vi.spyOn(tm, 'isHealthy').mockResolvedValue(false);

    await expect(tm.discoverRunningHub()).resolves.toBeNull();
  });
});
