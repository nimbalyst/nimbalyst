// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const RG_DIR = '/vendor/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/arm64-darwin';

vi.mock('../../utils/store', () => ({
  getAppSetting: (key: string) => (key === 'customPathDirs' ? '/custom/bin' : undefined),
}));

vi.mock('../WindowsPathResolver', () => ({
  getEnhancedWindowsPath: () => '',
}));

// Only the Anthropic vendored ripgrep "exists", at a fixed fake location.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (p: string) => p.includes('claude-agent-sdk') && p.endsWith('/rg'),
  };
});

vi.mock('path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('path')>();
  const dirname = (p: string) =>
    p.includes('claude-agent-sdk') && p.endsWith('/rg') ? RG_DIR : actual.dirname(p);
  return { ...actual, dirname, default: { ...actual, dirname } };
});

import { __setDetectedPathsForTest, getEnhancedPath } from '../shellEnvironment';

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const MISE_RUBY = '/Users/me/.local/share/mise/installs/ruby/3.3.0/bin';

describe('getEnhancedPath ordering (#1934)', () => {
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.PATH = LAUNCHD_PATH;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env.PATH = originalPath;
    __setDetectedPathsForTest(null);
  });

  it('puts the login shell PATH ahead of the launchd PATH, after custom dirs and ripgrep', () => {
    __setDetectedPathsForTest({
      shellPath: `${MISE_RUBY}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    });

    const entries = getEnhancedPath().split(':');

    expect(entries[0]).toBe('/custom/bin');
    expect(entries[1]).toBe(RG_DIR);
    expect(entries[2]).toBe(MISE_RUBY);
    expect(entries.indexOf(MISE_RUBY)).toBeLessThan(entries.indexOf('/usr/bin'));
    expect(entries.indexOf('/opt/homebrew/bin')).toBeLessThan(entries.indexOf('/usr/bin'));
    expect(new Set(entries).size).toBe(entries.length);
  });

  it('dedupes folders that differ only by trailing slash and drops empty segments', () => {
    process.env.PATH = '/usr/bin/:/bin::/usr/sbin:/sbin/';
    __setDetectedPathsForTest({
      shellPath: `${MISE_RUBY}/::/usr/bin:/bin/:/usr/sbin:`,
    });

    const entries = getEnhancedPath().split(':');

    expect(entries).not.toContain('');
    expect(entries.indexOf(MISE_RUBY)).toBe(2);
    expect(entries.indexOf(MISE_RUBY)).toBeLessThan(entries.indexOf('/usr/bin'));
    const normalized = entries.map((e) => e.replace(/\/+$/, ''));
    expect(new Set(normalized).size).toBe(normalized.length);
  });

  it('preserves whitespace in folder names and does not dedupe them against the unspaced folder', () => {
    process.env.PATH = '/opt/toolchain:/usr/bin';
    __setDetectedPathsForTest({ shellPath: '/opt/toolchain : /opt/lead:/usr/bin' });

    const entries = getEnhancedPath().split(':');

    expect(entries.slice(2, 6)).toEqual(['/opt/toolchain ', ' /opt/lead', '/usr/bin', '/opt/toolchain']);
  });

  it('keeps process.env.PATH first among system dirs before shell detection finishes', () => {
    process.env.PATH = '/early/bin:/usr/bin';
    const entries = getEnhancedPath().split(':');
    expect(entries.slice(0, 4)).toEqual(['/custom/bin', RG_DIR, '/early/bin', '/usr/bin']);
    expect(new Set(entries).size).toBe(entries.length);
  });
});
