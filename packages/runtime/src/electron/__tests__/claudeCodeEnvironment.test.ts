import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'path';

const {
  existsSyncMock,
  readdirSyncMock,
  getAppPathMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(candidate: string) => boolean>(),
  readdirSyncMock: vi.fn<(dir: string) => string[]>(() => []),
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
    readdirSync: readdirSyncMock,
  },
}));

// The unpacked native package dir that resolveNativeBinaryPath targets for
// darwin/arm64, given the mocked app path above.
const UNPACKED_SDK_DIR =
  '/Applications/Nimbalyst.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64';

describe('resolveClaudeCodeExecutablePath', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockReset();
    readdirSyncMock.mockReset();
    readdirSyncMock.mockReturnValue([]);
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

describe('setupClaudeCodeEnvironment updater pin (NIM-1573)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalDisableAutoupdater = process.env.DISABLE_AUTOUPDATER;

  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockReset();
    // Node-module resolution must succeed so setup doesn't throw in packaged mode.
    existsSyncMock.mockReturnValue(true);
    readdirSyncMock.mockReset();
    readdirSyncMock.mockReturnValue([]);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.DISABLE_AUTOUPDATER;
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalDisableAutoupdater === undefined) delete process.env.DISABLE_AUTOUPDATER;
    else process.env.DISABLE_AUTOUPDATER = originalDisableAutoupdater;
  });

  it('pins DISABLE_AUTOUPDATER for the login/check-login spawn env by default', async () => {
    const environment = await import('../claudeCodeEnvironment');
    const env = environment.setupClaudeCodeEnvironment();
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env.DISABLE_UPDATES).toBe('1');
  });

  it('does not clobber a user-set DISABLE_AUTOUPDATER', async () => {
    process.env.DISABLE_AUTOUPDATER = '0';
    const environment = await import('../claudeCodeEnvironment');
    const env = environment.setupClaudeCodeEnvironment();
    expect(env.DISABLE_AUTOUPDATER).toBe('0');
  });
});

describe('interrupted self-update detection (NIM-1573)', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');

  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockReset();
    readdirSyncMock.mockReset();
    readdirSyncMock.mockReturnValue([]);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalArch) Object.defineProperty(process, 'arch', originalArch);
  });

  it('resolveNativeBinaryPath returns undefined (never a dead path) when only an orphaned .old file remains', async () => {
    // claude(.exe) missing; a claude.old.<ts> orphan is present -- the exact
    // interrupted-self-update state. Resolution must NOT hand back a dead path.
    existsSyncMock.mockReturnValue(false);
    readdirSyncMock.mockReturnValue(['claude.old.1783585579626']);

    const environment = await import('../claudeCodeEnvironment');
    expect(environment.resolveNativeBinaryPath()).toBeUndefined();
  });

  it('findOrphanedClaudeUpdateFiles lists claude.old.* orphans in the unpacked SDK dir', async () => {
    existsSyncMock.mockImplementation((candidate: string) => candidate.replace(/\\/g, '/') === UNPACKED_SDK_DIR);
    readdirSyncMock.mockReturnValue([
      'claude.old.1783585579626',
      'claude.old.1783585999999',
      'package.json',
      'README.md',
    ]);

    const environment = await import('../claudeCodeEnvironment');
    const orphans = environment.findOrphanedClaudeUpdateFiles();
    expect(orphans).toEqual([
      path.join(UNPACKED_SDK_DIR, 'claude.old.1783585579626'),
      path.join(UNPACKED_SDK_DIR, 'claude.old.1783585999999'),
    ]);
  });

  it('describeMissingClaudeRuntime names the interrupted-update case only when orphans exist', async () => {
    const environment = await import('../claudeCodeEnvironment');

    // No orphans -> base "repair" message, no orphan/self-update note.
    existsSyncMock.mockReturnValue(false);
    readdirSyncMock.mockReturnValue([]);
    const base = environment.describeMissingClaudeRuntime();
    expect(base).toMatch(/repair Nimbalyst/i);
    expect(base).not.toMatch(/orphan/i);

    // Orphan present -> message additionally names the interrupted self-update.
    existsSyncMock.mockImplementation((candidate: string) => candidate.replace(/\\/g, '/') === UNPACKED_SDK_DIR);
    readdirSyncMock.mockReturnValue(['claude.old.1783585579626']);
    const withOrphan = environment.describeMissingClaudeRuntime();
    expect(withOrphan).toMatch(/repair Nimbalyst/i);
    expect(withOrphan).toMatch(/interrupted Claude CLI self-update/i);
    expect(withOrphan).toMatch(/orphaned/i);
  });
});
