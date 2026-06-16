import { describe, it, expect } from 'vitest';
import {
  parseGithubRemote,
  parseExternalId,
  buildUrn,
  buildExternalId,
} from '../backend';

describe('parseGithubRemote', () => {
  it('parses ssh, https, and ssh:// remote forms', () => {
    expect(parseGithubRemote('git@github.com:nimbalyst/nimbalyst.git')).toBe('nimbalyst/nimbalyst');
    expect(parseGithubRemote('https://github.com/nimbalyst/nimbalyst.git')).toBe('nimbalyst/nimbalyst');
    expect(parseGithubRemote('https://github.com/nimbalyst/nimbalyst')).toBe('nimbalyst/nimbalyst');
    expect(parseGithubRemote('ssh://git@github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('returns null for non-GitHub remotes', () => {
    expect(parseGithubRemote('git@gitlab.com:owner/repo.git')).toBeNull();
    expect(parseGithubRemote('')).toBeNull();
  });
});

describe('externalId <-> urn round-trip', () => {
  it('builds and parses consistently', () => {
    expect(buildExternalId('owner/repo', 42)).toBe('owner/repo#42');
    expect(buildUrn('owner/repo', 42)).toBe('github://owner/repo#42');
    expect(parseExternalId('owner/repo#42')).toEqual({ repo: 'owner/repo', number: 42 });
  });

  it('rejects malformed external ids', () => {
    expect(() => parseExternalId('owner/repo')).toThrow();
    expect(() => parseExternalId('nohash')).toThrow();
  });
});
