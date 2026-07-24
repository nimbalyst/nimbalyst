import { describe, it, expect } from 'vitest';
import { anonymize } from '../LogAnonymizer';

const HOME = '/Users/jane';
const WORKSPACE = '/Users/jane/code/my-cool-project';

const cfg = { homeDir: HOME, workspacePaths: [WORKSPACE] };

describe('LogAnonymizer', () => {
  it('replaces workspace paths before home directory so workspace match wins', () => {
    const input = `Loaded ${WORKSPACE}/notes/foo.md from ${HOME}/Library/cache`;
    const out = anonymize(input, cfg);
    expect(out).toContain('<WORKSPACE>/notes/foo.md');
    expect(out).toContain('~/Library/cache');
    expect(out).not.toContain('jane');
  });

  it('redacts email addresses', () => {
    expect(anonymize('contact alice@example.com for help', cfg)).toBe(
      'contact <EMAIL> for help',
    );
  });

  it('redacts anthropic and openai keys without confusing them', () => {
    const text = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and sk-aaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const out = anonymize(text, cfg);
    expect(out).not.toMatch(/sk-ant/);
    expect(out).not.toMatch(/sk-a/);
    expect(out.match(/<REDACTED_KEY>/g)?.length).toBe(2);
  });

  it('redacts github personal-access tokens', () => {
    expect(anonymize('token ghp_AAAAAAAAAAAAAAAAAAAAAAAA for push', cfg)).toContain(
      '<REDACTED_KEY>',
    );
  });

  it('redacts JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.fake-signature-here';
    expect(anonymize(`Authorization: ${jwt}`, cfg)).toContain('<REDACTED_JWT>');
  });

  it('redacts Stytch-style identifiers', () => {
    const text = 'member-prod-aaaaaaaaaaaaaaaaa was found';
    expect(anonymize(text, cfg)).toContain('<REDACTED_ID>');
  });

  it('redacts private IPv4 addresses', () => {
    const text = 'connecting to 192.168.1.42 and 10.0.0.7 and 172.16.5.5';
    const out = anonymize(text, cfg);
    expect(out).not.toMatch(/192\.168/);
    expect(out).not.toMatch(/10\.0\.0\.7/);
    expect(out).not.toMatch(/172\.16/);
  });

  it('leaves public IPv4 addresses alone', () => {
    expect(anonymize('hit 8.8.8.8 once', cfg)).toContain('8.8.8.8');
  });

  it('handles empty input', () => {
    expect(anonymize('', cfg)).toBe('');
  });

  it('does not require workspace paths', () => {
    const text = `Hi alice@example.com from ${HOME}/Desktop`;
    const out = anonymize(text, { homeDir: HOME });
    expect(out).toContain('<EMAIL>');
    expect(out).toContain('~/Desktop');
  });

  it('replaces multiple workspaces independently', () => {
    const otherWs = '/Users/jane/other-project';
    const text = `${WORKSPACE}/a vs ${otherWs}/b`;
    const out = anonymize(text, { homeDir: HOME, workspacePaths: [WORKSPACE, otherWs] });
    expect(out).toBe('<WORKSPACE>/a vs <WORKSPACE>/b');
  });
});

// Windows path forms: os.homedir() returns the backslash form, but logs render
// the same path several ways. Before the path-variant fix these all leaked the
// username / workspace dir into the public issue.
describe('LogAnonymizer Windows path forms', () => {
  const WIN_HOME = 'C:\\Users\\andre';
  const WIN_WS = 'C:\\Projects\\client-acme';
  const winCfg = { homeDir: WIN_HOME, workspacePaths: [WIN_WS] };

  it('redacts the native backslash home path', () => {
    const out = anonymize('open C:\\Users\\andre\\Desktop\\a.md', winCfg);
    expect(out).not.toMatch(/andre/i);
  });

  it('redacts the forward-slash Windows home path', () => {
    const out = anonymize('open C:/Users/andre/Desktop/a.md', winCfg);
    expect(out).not.toMatch(/andre/i);
  });

  it('redacts the Git Bash /c/ home path', () => {
    const out = anonymize('cwd /c/Users/andre/proj', winCfg);
    expect(out).not.toMatch(/andre/i);
  });

  it('redacts the WSL /mnt/c/ home path', () => {
    const out = anonymize('cwd /mnt/c/Users/andre/proj', winCfg);
    expect(out).not.toMatch(/andre/i);
  });

  it('redacts the JSON-escaped home path', () => {
    const out = anonymize('"cwd":"C:\\\\Users\\\\andre\\\\x"', winCfg);
    expect(out).not.toMatch(/andre/i);
  });

  it('matches the home path case-insensitively', () => {
    const out = anonymize('open c:\\users\\andre\\x', winCfg);
    expect(out).not.toMatch(/andre/i);
  });

  it('redacts a Windows workspace path outside the home dir', () => {
    const out = anonymize('loaded C:\\Projects\\client-acme\\src\\m.ts', winCfg);
    expect(out).toContain('<WORKSPACE>');
    expect(out).not.toMatch(/client-acme/i);
  });

  it('does not over-redact a bare word that only appears as a path segment', () => {
    // "acme" on its own is not the full workspace path and must pass through.
    expect(anonymize('the acme module loaded', winCfg)).toContain('acme module');
  });

  it('still works with no workspace paths supplied', () => {
    const out = anonymize('open C:\\Users\\andre\\x', { homeDir: WIN_HOME });
    expect(out).not.toMatch(/andre/i);
  });
});
