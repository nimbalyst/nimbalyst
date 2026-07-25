import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { resolveClaudeConfigDir, resolveClaudeCredentialsPath } from '../claudeCode/claudeConfigDir';
import {
  describeClaudeCredentialSource,
  resolveClaudeKeychainServiceNames,
} from '../claudeCode/claudeKeychain';

const HOME = '/Users/example';

// os.homedir() is a namespace export, so it can't be spied on under ESM.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => HOME }, homedir: () => HOME };
});

describe('resolveClaudeConfigDir', () => {
  it('defaults to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    expect(resolveClaudeConfigDir({})).toBe(path.join(HOME, '.claude'));
  });

  it('honors CLAUDE_CONFIG_DIR (GitHub #975)', () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: 'D:\\claude-config' })).toBe('D:\\claude-config');
  });

  it('treats a blank CLAUDE_CONFIG_DIR as unset rather than as the empty path', () => {
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: '   ' })).toBe(path.join(HOME, '.claude'));
  });

  it('NFC-normalizes the dir so the keychain scope hash matches the CLI byte-for-byte', () => {
    const nfd = '/tmp/café-config'; // "e" + combining acute
    const nfc = '/tmp/café-config'; // precomposed "é"
    expect(nfd).not.toBe(nfc);
    expect(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: nfd })).toBe(nfc);
  });
});

describe('resolveClaudeCredentialsPath', () => {
  it('reads .credentials.json out of the resolved config dir', () => {
    expect(resolveClaudeCredentialsPath({})).toBe(path.join(HOME, '.claude', '.credentials.json'));
    expect(resolveClaudeCredentialsPath({ CLAUDE_CONFIG_DIR: '/tmp/claude-config' })).toBe(
      path.join('/tmp/claude-config', '.credentials.json'),
    );
  });
});

describe('resolveClaudeKeychainServiceNames', () => {
  it('uses the historical unscoped cascade when no config dir is configured', () => {
    expect(resolveClaudeKeychainServiceNames({})).toEqual(['Claude Code-credentials', 'Claude Code']);
  });

  it('scopes the service name by config dir hash, matching the CLI algorithm', () => {
    // sha256('/tmp/claude-config').slice(0, 8) — fixed vector, mirrors
    // `Claude Code${OAUTH_FILE_SUFFIX}-credentials-${hash}` in sdk.mjs.
    expect(resolveClaudeKeychainServiceNames({ CLAUDE_CONFIG_DIR: '/tmp/claude-config' })).toEqual([
      'Claude Code-credentials-19aa18c8',
    ]);
  });

  it('does not fall back to the unscoped entry, which belongs to another config root', () => {
    const names = resolveClaudeKeychainServiceNames({ CLAUDE_CONFIG_DIR: '/tmp/claude-config' });
    expect(names).not.toContain('Claude Code-credentials');
    expect(names).not.toContain('Claude Code');
  });

  it('lets CLAUDE_SECURESTORAGE_CONFIG_DIR override the scope', () => {
    expect(
      resolveClaudeKeychainServiceNames({
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/Users/example/.claude',
      }),
    ).toEqual(['Claude Code-credentials-402b469b']);
  });

  it('treats a set-but-empty CLAUDE_SECURESTORAGE_CONFIG_DIR as the CLI signal to use the unscoped entry', () => {
    expect(
      resolveClaudeKeychainServiceNames({
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      }),
    ).toEqual(['Claude Code-credentials', 'Claude Code']);
  });
});

describe('describeClaudeCredentialSource', () => {
  it('names the resolved file path on windows and linux', () => {
    expect(describeClaudeCredentialSource({ CLAUDE_CONFIG_DIR: 'D:\\claude-config' }, 'win32')).toBe(
      path.join('D:\\claude-config', '.credentials.json'),
    );
  });

  it('names the scoped keychain entry and the file fallback on darwin', () => {
    const described = describeClaudeCredentialSource({ CLAUDE_CONFIG_DIR: '/tmp/claude-config' }, 'darwin');
    expect(described).toContain('Claude Code-credentials-19aa18c8');
    expect(described).toContain(path.join('/tmp/claude-config', '.credentials.json'));
  });
});
