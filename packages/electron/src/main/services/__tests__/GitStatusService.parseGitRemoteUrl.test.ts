import { describe, it, expect } from 'vitest';
import { parseGitRemoteUrl } from '../GitStatusService';

describe('parseGitRemoteUrl', () => {
  it('parses SSH shorthand', () => {
    expect(parseGitRemoteUrl('git@github.com:nimbalyst/nimbalyst.git')).toEqual({
      host: 'github.com',
      remote: 'nimbalyst/nimbalyst',
    });
  });

  it('parses SSH shorthand without the .git suffix', () => {
    expect(parseGitRemoteUrl('git@github.com:owner/repo')).toEqual({
      host: 'github.com',
      remote: 'owner/repo',
    });
  });

  it('parses ssh:// URLs', () => {
    expect(parseGitRemoteUrl('ssh://git@github.com/owner/repo.git')).toEqual({
      host: 'github.com',
      remote: 'owner/repo',
    });
  });

  it('parses https URLs with and without .git', () => {
    expect(parseGitRemoteUrl('https://github.com/owner/repo.git')).toEqual({
      host: 'github.com',
      remote: 'owner/repo',
    });
    expect(parseGitRemoteUrl('https://github.com/owner/repo')).toEqual({
      host: 'github.com',
      remote: 'owner/repo',
    });
  });

  it('parses GitHub Enterprise hosts (SSH + HTTPS)', () => {
    expect(parseGitRemoteUrl('git@ghe.example.com:team/app.git')).toEqual({
      host: 'ghe.example.com',
      remote: 'team/app',
    });
    expect(parseGitRemoteUrl('https://ghe.example.com/team/app.git')).toEqual({
      host: 'ghe.example.com',
      remote: 'team/app',
    });
  });

  it('returns null for empty or non-repo URLs', () => {
    expect(parseGitRemoteUrl('')).toBeNull();
    expect(parseGitRemoteUrl('https://github.com/owner')).toBeNull();
  });
});
