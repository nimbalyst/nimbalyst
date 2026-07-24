import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const {
  execSyncMock,
  execMock,
  spawnMock,
  safeHandleMock,
  findExecutableInWindowsPathMock,
  getEnhancedWindowsPathMock,
  simpleGitMock,
} = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execMock: vi.fn((_command: string, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(new Error('offline'), '', '');
  }),
  spawnMock: vi.fn(),
  safeHandleMock: vi.fn(),
  findExecutableInWindowsPathMock: vi.fn(),
  getEnhancedWindowsPathMock: vi.fn(),
  simpleGitMock: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  shell: {
    openExternal: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  spawn: spawnMock,
  exec: execMock,
  execSync: execSyncMock,
}));

vi.mock('../WindowsPathResolver', () => ({
  findExecutableInWindowsPath: findExecutableInWindowsPathMock,
  getEnhancedWindowsPath: getEnhancedWindowsPathMock,
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: safeHandleMock,
}));

vi.mock('../../utils/store', () => ({
  getAppSetting: vi.fn(() => null),
}));

vi.mock('../services/analytics/AnalyticsService.ts', () => ({
  AnalyticsService: {
    getInstance: () => ({
      sendEvent: vi.fn(),
    }),
  },
}));

vi.mock('simple-git', () => ({
  simpleGit: simpleGitMock,
}));

import { CLIManager } from '../CLIManager';

describe('CLIManager.checkClaudeCodeWindowsInstallation', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
    });

    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    getEnhancedWindowsPathMock.mockReturnValue('C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs');
    findExecutableInWindowsPathMock.mockReturnValue('C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd');
    simpleGitMock.mockReturnValue({
      version: vi.fn().mockResolvedValue({ installed: false }),
    });
    execSyncMock.mockReset();
    execMock.mockClear();
    spawnMock.mockReset();
    safeHandleMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('detects a Windows npm installation exposed as claude.cmd on PATH', async () => {
    execSyncMock.mockImplementation((command: string, options?: { env?: Record<string, string> }) => {
      if (command === '"C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd" --version') {
        expect(options?.env?.PATH).toBe('C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs');
        return '1.2.3\n';
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const manager = new CLIManager();
    const result = await manager.checkClaudeCodeWindowsInstallation();

    expect(findExecutableInWindowsPathMock).toHaveBeenCalledWith(
      ['claude.cmd', 'claude.exe'],
      'C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs'
    );
    expect(result).toEqual({
      isPlatformWindows: true,
      gitVersion: undefined,
      claudeCodeVersion: '1.2.3',
    });
  });

  it('detects a Windows Codex installation exposed as codex.cmd on PATH', async () => {
    findExecutableInWindowsPathMock.mockImplementation((executables: string | string[]) => {
      if (Array.isArray(executables) && executables.includes('codex.cmd')) {
        return 'C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd';
      }
      return 'C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd';
    });

    spawnMock.mockImplementation((command: string, args: string[], options?: { shell?: boolean; env?: Record<string, string> }) => {
      expect(command).toBe('C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd');
      expect(args).toEqual(['--version']);
      expect(options?.shell).toBe(false);
      expect(options?.env?.PATH).toBe('C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs');

      let stdoutHandler: ((data: Buffer | string) => void) | undefined;
      let closeHandler: ((code: number) => void) | undefined;
      const child = {
        stdout: {
          on: vi.fn((event: string, handler: (data: Buffer | string) => void) => {
            if (event === 'data') stdoutHandler = handler;
          }),
        },
        stderr: {
          on: vi.fn(),
        },
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          if (event === 'close') closeHandler = handler as (code: number) => void;
        }),
        kill: vi.fn(),
      };

      queueMicrotask(() => {
        stdoutHandler?.('codex 0.12.3\n');
        closeHandler?.(0);
      });

      return child as any;
    });

    const manager = new CLIManager();
    const result = await manager.checkInstallation('openai-codex');

    expect(result).toEqual({
      installed: true,
      version: '0.12.3',
      updateAvailable: false,
      path: 'C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd',
      latestVersion: undefined,
    });
    expect(findExecutableInWindowsPathMock).toHaveBeenCalledWith(
      ['codex.cmd', 'codex.exe'],
      'C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs'
    );
  });
});
