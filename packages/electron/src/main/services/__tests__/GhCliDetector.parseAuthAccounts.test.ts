import { describe, it, expect } from 'vitest';
import { parseAuthAccounts } from '../GhCliDetector';

describe('parseAuthAccounts', () => {
  it('parses multiple accounts and marks the active one', () => {
    const text = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token scopes: 'repo'

  ✓ Logged in to github.com account work-emu (keyring)
  - Active account: false
  - Git operations protocol: https`;
    const accounts = parseAuthAccounts(text);
    expect(accounts).toEqual([
      { host: 'github.com', login: 'octocat', active: true },
      { host: 'github.com', login: 'work-emu', active: false },
    ]);
  });

  it('treats a lone account as active when there is no Active-account line (legacy gh)', () => {
    const text = 'Logged in to github.com as octocat (oauth_token)';
    expect(parseAuthAccounts(text)).toEqual([{ host: 'github.com', login: 'octocat', active: true }]);
  });

  it('parses GitHub Enterprise hosts', () => {
    const text = `  ✓ Logged in to ghe.example.com account devuser (keyring)
  - Active account: true`;
    expect(parseAuthAccounts(text)).toEqual([
      { host: 'ghe.example.com', login: 'devuser', active: true },
    ]);
  });

  it('returns an empty array when not logged in', () => {
    expect(parseAuthAccounts('You are not logged into any GitHub hosts.')).toEqual([]);
  });
});
