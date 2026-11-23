// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const capturedRequests: Array<{
  host?: string;
  port?: number;
  path?: string;
  method?: string;
  rejectUnauthorized?: boolean;
  headers?: Record<string, string | number>;
}> = [];

vi.mock('https', () => ({
  request: (
    opts: {
      host?: string;
      port?: number;
      path?: string;
      method?: string;
      rejectUnauthorized?: boolean;
      headers?: Record<string, string | number>;
    },
    cb: (res: EventEmitter & { statusCode?: number }) => void,
  ) => {
    capturedRequests.push(opts);
    const req = new EventEmitter() as EventEmitter & {
      write: (chunk: unknown) => void;
      end: () => void;
      destroy: (err?: Error) => void;
    };
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode?: number };
      res.statusCode = 200;
      cb(res);
      res.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            userStatus: {
              name: 'Test User',
              email: 'test@example.com',
              planStatus: {
                planInfo: {
                  teamsTier: 'TEAMS_TIER_PRO',
                  planName: 'Pro',
                  monthlyPromptCredits: 500,
                },
                availablePromptCredits: 420,
              },
              cascadeModelConfigData: {
                clientModelConfigs: [
                  {
                    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M1' },
                    label: 'Gemini 4 Neon',
                    quotaInfo: {
                      remainingFraction: 0.75,
                      resetTime: '2026-11-24T00:00:00Z',
                    },
                  },
                ],
              },
            },
          }),
        ),
      );
      res.emit('end');
    };
    return req;
  },
}));

// Imported AFTER vi.mock so AntigravityServerManager's `import * as https` binds the mock.
import {
  AntigravityServerManager,
  parseAgyHttpsPortFromLog,
  readAgyHttpsPortFromLogFile,
} from '../AntigravityServerManager';
import { AntigravityUsageMeter } from '../AntigravityUsageMeter';

function freshManager(): AntigravityServerManager {
  (AntigravityServerManager as unknown as { instance: unknown }).instance = null;
  return AntigravityServerManager.shared();
}

afterEach(() => {
  capturedRequests.length = 0;
  vi.restoreAllMocks();
});

describe('agy acp log port parsing and external endpoint usage polling', () => {
  it('extracts the HTTPS (gRPC) port from agy acp log lines and ignores the plain HTTP line', () => {
    const sampleLog = [
      'I1123 14:12:50.100000      1 serve.go:30] Starting ACP server (pid 1980, worker=false, isJetski=false)',
      'I1123 14:12:50.280929     70 server.go:1305] Language server listening on random port at 57147 for HTTPS (gRPC)',
      'I1123 14:12:50.280929     70 server.go:1313] Language server listening on random port at 57148 for HTTP',
    ].join('\n');

    expect(parseAgyHttpsPortFromLog(sampleLog)).toBe(57147);
  });

  it('returns the latest valid HTTPS port when multiple entries exist and null when absent or invalid', () => {
    const restartedLog = [
      'I1123 14:12:50.280929     70 server.go:1305] Language server listening on random port at 57147 for HTTPS (gRPC)',
      'I1123 14:20:10.100000     70 server.go:1305] Language server listening on random port at 61302 for HTTPS (gRPC)',
    ].join('\n');

    expect(parseAgyHttpsPortFromLog(restartedLog)).toBe(61302);
    expect(parseAgyHttpsPortFromLog('Language server listening on random port at 57148 for HTTP')).toBeNull();
    expect(parseAgyHttpsPortFromLog('Language server listening on random port at 99999 for HTTPS (gRPC)')).toBeNull();
    expect(parseAgyHttpsPortFromLog('')).toBeNull();
  });

  it('reads the HTTPS port from a --cli_log_file on disk and returns null when missing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-log-port-test-'));
    try {
      const logPath = path.join(tmpDir, 'acp.log');
      expect(await readAgyHttpsPortFromLogFile(logPath)).toBeNull();

      fs.writeFileSync(
        logPath,
        'I1123 15:11:39.000000 70 server.go:1305] Language server listening on random port at 61302 for HTTPS (gRPC)\n',
        'utf8',
      );
      expect(await readAgyHttpsPortFromLogFile(logPath)).toBe(61302);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('registers an external endpoint without CSRF header and serves AntigravityUsageMeter.getSnapshot', async () => {
    const manager = freshManager();
    expect(manager.currentEndpoint()).toBeNull();

    manager.registerExternalEndpoint({ httpsPort: 61302, csrf: '' });
    const ep = manager.currentEndpoint();
    expect(ep).toEqual({ httpsPort: 61302, csrf: '', owned: false });

    const snapshot = await new AntigravityUsageMeter(manager).getSnapshot(ep!);
    expect(snapshot.account).toMatchObject({
      name: 'Test User',
      planName: 'Pro',
      availablePromptCredits: 420,
    });
    expect(snapshot.models.MODEL_PLACEHOLDER_M1).toMatchObject({
      label: 'Gemini 4 Neon',
      remainingFraction: 0.75,
    });

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].port).toBe(61302);
    expect(capturedRequests[0].path).toBe('/exa.language_server_pb.LanguageServerService/GetUserStatus');
    expect(capturedRequests[0].rejectUnauthorized).toBe(false);
    expect(capturedRequests[0].headers).not.toHaveProperty('x-codeium-csrf-token');

    // Non-empty CSRF still sends the header for legacy hub endpoints.
    await manager.getUserStatus({ httpsPort: 51717, csrf: 'hub-token', owned: false });
    expect(capturedRequests[1].headers?.['x-codeium-csrf-token']).toBe('hub-token');

    // Clearing a different port leaves the active external endpoint intact.
    manager.clearExternalEndpoint(51717);
    expect(manager.currentEndpoint()).toEqual({ httpsPort: 61302, csrf: '', owned: false });

    manager.clearExternalEndpoint(61302);
    expect(manager.currentEndpoint()).toBeNull();
  });
});
