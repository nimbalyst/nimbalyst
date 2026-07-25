import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityServerManager, type AntigravityEndpoint } from '../ServerManager';

type TestableAntigravityServerManager = {
  discoverRunningHub: () => Promise<AntigravityEndpoint | null>;
  isHealthy: (endpoint: AntigravityEndpoint) => Promise<boolean>;
  runCommand: (executable: string, args: readonly string[]) => Promise<string>;
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
});
