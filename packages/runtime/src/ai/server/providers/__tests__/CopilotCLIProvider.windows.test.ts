import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { existsSyncMock, homedirMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  homedirMock: vi.fn(() => 'C:\\Users\\test'),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: existsSyncMock,
  },
  existsSync: existsSyncMock,
}));

vi.mock('os', () => ({
  default: {
    homedir: homedirMock,
  },
  homedir: homedirMock,
}));

import { CopilotCLIProvider } from '../CopilotCLIProvider';

describe('CopilotCLIProvider Windows runtime resolution', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalAppData = process.env.APPDATA;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming';
    process.env.PATH = 'C:\\Windows\\System32';
    existsSyncMock.mockReset();
    CopilotCLIProvider.setCopilotPathLoader(null);
    CopilotCLIProvider.setEnhancedPathLoader(null);
    CopilotCLIProvider.setShellEnvironmentLoader(null);
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    CopilotCLIProvider.setCopilotPathLoader(null);
    CopilotCLIProvider.setEnhancedPathLoader(null);
    CopilotCLIProvider.setShellEnvironmentLoader(null);
    vi.restoreAllMocks();
  });

  it('resolves copilot.cmd from enhanced PATH on Windows', () => {
    const enhancedPath = 'C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs';
    CopilotCLIProvider.setEnhancedPathLoader(() => enhancedPath);

    existsSyncMock.mockImplementation((candidate: string) =>
      candidate === 'C:\\Users\\test\\AppData\\Roaming\\npm\\copilot.cmd'
    );

    const resolved = (CopilotCLIProvider as any).resolveCopilotExecutableForRuntime(enhancedPath);

    expect(resolved).toBe('C:\\Users\\test\\AppData\\Roaming\\npm\\copilot.cmd');
  });

  it('configureProtocol uses the resolved Windows copilot.cmd path', () => {
    const enhancedPath = 'C:\\Users\\test\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs';
    CopilotCLIProvider.setEnhancedPathLoader(() => enhancedPath);

    existsSyncMock.mockImplementation((candidate: string) =>
      candidate === 'C:\\Users\\test\\AppData\\Roaming\\npm\\copilot.cmd'
    );

    const protocol = {
      setCopilotPath: vi.fn(),
      setProcessEnv: vi.fn(),
    };

    const provider = new CopilotCLIProvider({ protocol: protocol as any });
    (provider as any).configureProtocol();

    expect(protocol.setCopilotPath).toHaveBeenCalledWith('C:\\Users\\test\\AppData\\Roaming\\npm\\copilot.cmd');
    expect(protocol.setProcessEnv).toHaveBeenCalled();
  });
});
