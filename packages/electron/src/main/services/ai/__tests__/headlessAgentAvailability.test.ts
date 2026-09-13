// @vitest-environment node
/**
 * The default on/off state for these providers is decided by the machine.
 * The hazard that shape carries is well known here: persist the decision at
 * first boot and the app overrides a user who turned the provider off, with
 * the bug only appearing on launch two.
 *
 * These tests pin the property that makes that impossible — detection is a
 * *fallback*, never a write — plus the sign-in rules, which are the difference
 * between "usable agent" and "agent that fails on the first turn".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'child_process';
import { decideAvailability, __resetHeadlessAgentAvailabilityForTests, refreshHeadlessAgentAvailability, getCachedHeadlessAgentAvailability } from '../headlessAgentAvailability';
import { resolveProviderEnabled } from '../modelEnablementFilter';

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(), execFile: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs')>(), existsSync: vi.fn(() => true),
}));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); __resetHeadlessAgentAvailabilityForTests(); });

it.each([undefined, '/fixture/bin'])('does not mistake inherited API keys for CLI login (PATH %s)', async (enhancedPath) => {
  vi.stubEnv('CURSOR_API_KEY', 'synthetic-cursor');
  vi.stubEnv('XAI_API_KEY', 'synthetic-xai');
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'synthetic-anthropic');
  const environments: NodeJS.ProcessEnv[] = [];
  vi.mocked(execFile).mockImplementation(((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const env = options.env;
    environments.push(env);
    callback(null, env.CURSOR_API_KEY || env.XAI_API_KEY ? 'Signed in' : 'Not logged in', '');
  }) as unknown as typeof execFile);
  await refreshHeadlessAgentAvailability(enhancedPath);
  expect(getCachedHeadlessAgentAvailability('cursor-agent').signedIn).toBe(false);
  expect(getCachedHeadlessAgentAvailability('grok-build').signedIn).toBe(false);
  expect(environments).toHaveLength(2);
  for (const env of environments) {
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.PATH).toBe(enhancedPath ?? process.env.PATH);
  }
  expect(process.env.CURSOR_API_KEY).toBe('synthetic-cursor');
});

const EXE = '/Users/fixture/.local/bin/grok';

describe('decideAvailability', () => {
  it('treats a missing binary as unavailable', () => {
    expect(decideAvailability('grok-build', {})).toEqual({ installed: false, signedIn: false });
  });

  it('reads sign-out from output, not exit code', () => {
    // `grok models` exits 0 while printing "You are not authenticated", and
    // `cursor-agent status` exits 0 either way -- so the text is the only signal.
    expect(decideAvailability('grok-build', {
      executablePath: EXE,
      authOutput: 'You are not authenticated.\n\nDefault model: grok-4.6',
    })).toMatchObject({ installed: true, signedIn: false });

    expect(decideAvailability('cursor-agent', {
      executablePath: EXE,
      authOutput: ' Not logged in',
    })).toMatchObject({ installed: true, signedIn: false });
  });

  it('treats an unrecognized success message as signed in', () => {
    // Matched negatively on purpose: a vendor rewording their success string
    // must not silently disable the provider for everyone.
    expect(decideAvailability('grok-build', {
      executablePath: EXE,
      authOutput: 'You are logged in with grok.com.',
    })).toMatchObject({ installed: true, signedIn: true });

    expect(decideAvailability('cursor-agent', {
      executablePath: EXE,
      authOutput: 'Signed in as fixture@example.com (via some new phrasing)',
    })).toMatchObject({ installed: true, signedIn: true });
  });

  it('treats a CLI that would not run as unusable', () => {
    expect(decideAvailability('grok-build', { executablePath: EXE, authFailed: true }))
      .toMatchObject({ installed: true, signedIn: false });
  });
});

describe('resolveProviderEnabled for detected-default providers', () => {
  beforeEach(() => {
    __resetHeadlessAgentAvailabilityForTests();
  });

  it('is off before detection has run, so startup never blocks on a probe', () => {
    expect(resolveProviderEnabled('grok-build', undefined)).toBe(false);
  });

  it('turns on once the CLI is detected and signed in, with nothing stored', () => {
    __resetHeadlessAgentAvailabilityForTests({
      'grok-build': { installed: true, signedIn: true, executablePath: EXE },
    });
    expect(resolveProviderEnabled('grok-build', undefined)).toBe(true);
    // Installed but signed out is NOT enough: it would put an agent in the
    // picker that errors on the user's first turn.
    __resetHeadlessAgentAvailabilityForTests({
      'grok-build': { installed: true, signedIn: false, executablePath: EXE },
    });
    expect(resolveProviderEnabled('grok-build', undefined)).toBe(false);
  });

  it('never overrides an explicit choice, on either launch', () => {
    // The second-launch case. Detection says "available" every time, so if it
    // could win, a user who turned the provider off would find it back on
    // after every restart -- forever, and only ever visibly on launch two.
    __resetHeadlessAgentAvailabilityForTests({
      'cursor-agent': { installed: true, signedIn: true, executablePath: EXE },
    });
    for (const launch of [1, 2, 3]) {
      expect(resolveProviderEnabled('cursor-agent', { enabled: false }), `launch ${launch}`).toBe(false);
    }

    // And the converse: explicitly on stays on when the CLI goes away, so the
    // user sees the provider's own "not installed" message instead of it
    // silently vanishing from settings.
    __resetHeadlessAgentAvailabilityForTests();
    expect(resolveProviderEnabled('cursor-agent', { enabled: true })).toBe(true);
  });

  it('leaves every other provider on its static default', () => {
    __resetHeadlessAgentAvailabilityForTests({
      'grok-build': { installed: true, signedIn: true, executablePath: EXE },
    });
    expect(resolveProviderEnabled('claude-code', undefined)).toBe(true);
    expect(resolveProviderEnabled('claude-code-cli', undefined)).toBe(false);
    expect(resolveProviderEnabled('opencode', undefined)).toBe(false);
  });

  describe('gemini, whose sign-in cannot be probed', () => {
    const APP = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';

    it('reports signed in on presence alone', () => {
      // Not an assumption that the user IS signed in — a statement about what
      // is knowable. Antigravity's credential lives in the macOS keychain, so
      // the alternatives are a keychain prompt or spawning a ~120MB language
      // server on every model-list read. A signed-out user gets one clear
      // error on their first turn instead.
      expect(decideAvailability('antigravity-gemini-agent', { executablePath: APP }))
        .toEqual({ installed: true, signedIn: true, executablePath: APP });
    });

    it('is unavailable when Antigravity is not installed', () => {
      expect(decideAvailability('antigravity-gemini-agent', {}))
        .toEqual({ installed: false, signedIn: false });
    });

    it('still lets an explicit choice win on every launch', () => {
      // The same second-launch property as the CLI agents. Detection here is
      // even more eager (presence alone), so it matters more that it can never
      // overwrite a user who turned Gemini off.
      __resetHeadlessAgentAvailabilityForTests({
        'antigravity-gemini-agent': { installed: true, signedIn: true, executablePath: APP },
      });
      expect(resolveProviderEnabled('antigravity-gemini-agent', undefined)).toBe(true);
      for (const launch of [1, 2, 3]) {
        expect(
          resolveProviderEnabled('antigravity-gemini-agent', { enabled: false }),
          `launch ${launch}`,
        ).toBe(false);
      }
    });
  });
});
