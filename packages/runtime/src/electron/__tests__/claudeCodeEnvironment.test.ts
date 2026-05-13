import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  existsSyncMock,
  getAppPathMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(candidate: string) => boolean>(),
  getAppPathMock: vi.fn(() => '/Applications/Nimbalyst.app/Contents/Resources/app.asar'),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: getAppPathMock,
  },
}));

vi.mock('fs', () => ({
  default: {
    existsSync: existsSyncMock,
    readdirSync: vi.fn(() => []),
  },
}));

describe('resolveClaudeCodeExecutablePath', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    process.env.HOME = '/Users/test';
    process.env.PATH = '/usr/bin:/bin';
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalArch) Object.defineProperty(process, 'arch', originalArch);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('ignores a packaged asar fallback path and uses a system-installed CLI only when explicitly allowed', async () => {
    existsSyncMock.mockImplementation((candidate: string) => candidate === '/opt/homebrew/bin/claude');

    const environment = await import('../claudeCodeEnvironment');
    expect(environment.resolveNativeBinaryPath()).toBeUndefined();
    expect(
      environment.resolveClaudeCodeExecutablePath({
        pathValue: '/opt/homebrew/bin:/usr/bin:/bin',
      })
    ).toBeUndefined();
    expect(
      environment.resolveClaudeCodeExecutablePath({
        pathValue: '/opt/homebrew/bin:/usr/bin:/bin',
        allowSystemFallback: true,
      })
    ).toBe('/opt/homebrew/bin/claude');
  });
});
