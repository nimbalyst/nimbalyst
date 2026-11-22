// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A keychain entry that is not valid JSON must not reach the log. Node's JSON error text
 * quotes the start of the input, and that input is the credential entry.
 */
const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('child_process', () => ({ execSync: mocks.execSync }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/logger', () => ({
  logger: { main: { warn: mocks.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));
vi.mock('../shellEnvironment', () => ({ getShellEnvironment: () => ({}) }));
vi.mock('../ClaudeSettingsManager', () => ({
  ClaudeSettingsManager: { getInstance: () => ({ getUserLevelEnv: async () => ({}) }) },
}));
vi.mock('../UsageHistoryStore', () => ({ usageHistoryStore: {} }));

import { claudeUsageService } from '../ClaudeUsageService';

// Short, so Node's JSON error text (which quotes only the first few characters) holds all of it.
const SECRET = 'sk-fake-77';
const originalPlatform = process.platform;

describe('ClaudeUsageService keychain read errors', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mocks.warn.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('logs the error name and code only, never the entry text', async () => {
    mocks.execSync.mockReturnValue(SECRET);
    await claudeUsageService.getAccessTokenForApi();

    const keychainWarnings = mocks.warn.mock.calls.filter((call) => String(call[0]).includes('keychain'));
    expect(keychainWarnings.length).toBeGreaterThan(0);
    // JSON.stringify shows an Error as {}, so write each Error out with its message first.
    const text = JSON.stringify(
      keychainWarnings.map((call) => call.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : arg))),
    );
    expect(text).toContain('SyntaxError');
    expect(text).not.toContain(SECRET);
  });
});

describe('ClaudeUsageService credentials file read errors', () => {
  const CREDENTIALS_SECRET = 'sk-fake-88';
  let configDir: string;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    // Linux skips the keychain, so the credentials file is the only source read.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-test-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    mocks.warn.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('logs the error name only, never the file text', async () => {
    fs.writeFileSync(path.join(configDir, '.credentials.json'), CREDENTIALS_SECRET);
    await claudeUsageService.getAccessTokenForApi();

    const warnings = mocks.warn.mock.calls.filter((call) => String(call[0]).includes('credentials file'));
    expect(warnings.length).toBeGreaterThan(0);
    const text = JSON.stringify(
      warnings.map((call) => call.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : arg))),
    );
    expect(text).toContain('SyntaxError');
    expect(text).not.toContain(CREDENTIALS_SECRET);
  });
});
