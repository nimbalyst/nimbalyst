// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(),
  execFile: childProcessMocks.execFile,
}));

import { CursorAgentProvider } from '../CursorAgentProvider';
import { GrokBuildProvider } from '../GrokBuildProvider';
import { scrubProviderApiKeys } from '../../providerApiKeyScrub';

const credentialNames = [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CURSOR_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY',
  'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
];

afterEach(() => {
  childProcessMocks.execFile.mockReset();
  CursorAgentProvider.setCursorPathLoader(null);
  GrokBuildProvider.setGrokPathLoader(null);
  for (const provider of [CursorAgentProvider, GrokBuildProvider]) {
    provider.setShellEnvironmentLoader(null);
    provider.setEnhancedPathLoader(null);
  }
  vi.unstubAllEnvs();
});

describe('headless CLI model catalogs', () => {
  it('scrubs API keys and alternate auth tokens while preserving CLI login configuration', () => {
    const env = { ...Object.fromEntries(credentialNames.map((key) => [key, 'synthetic'])), HOME: '/fixture/home' };
    expect(scrubProviderApiKeys(env)).toEqual({ HOME: '/fixture/home' });
  });

  it.each([false, true])('uses scrubbed environments for both catalogs (shell loaders: %s)', async (withLoaders) => {
    for (const key of credentialNames) vi.stubEnv(key, 'synthetic-parent');
    for (const provider of [CursorAgentProvider, GrokBuildProvider]) {
      if (withLoaders) {
        provider.setShellEnvironmentLoader(() => ({ CURSOR_API_KEY: 'synthetic-shell', SHELL_MARKER: 'present' }));
        provider.setEnhancedPathLoader(() => '/fixture/bin');
      }
      childProcessMocks.execFile.mockImplementation((_command, _args, _options, callback) => callback(null, '', ''));
      await provider.getModels();
      const env = childProcessMocks.execFile.mock.lastCall![2].env;
      for (const key of credentialNames) expect(env[key], key).toBeUndefined();
      expect(env.HOME).toBe(process.env.HOME);
      if (withLoaders) expect(env).toMatchObject({ PATH: '/fixture/bin', SHELL_MARKER: 'present' });
      expect(process.env.CURSOR_API_KEY).toBe('synthetic-parent');
    }
  });

  it('discovers Grok models without synchronously blocking the caller', async () => {
    childProcessMocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null, 'Available models:\n  * grok-4.6 (default)\n  - grok-4.5\n', ''));
    });

    await expect(GrokBuildProvider.getModels()).resolves.toEqual([
      { id: 'grok-build:grok-4.6', name: 'grok-4.6', provider: 'grok-build' },
      { id: 'grok-build:grok-4.5', name: 'grok-4.5', provider: 'grok-build' },
    ]);
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'grok',
      ['models'],
      expect.objectContaining({ encoding: 'utf8', timeout: 10_000 }),
      expect.any(Function),
    );
  });

  it('discovers Cursor models without synchronously blocking the caller', async () => {
    childProcessMocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(
        null,
        'Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex - Codex 5.3\n',
        '',
      ));
    });

    await expect(CursorAgentProvider.getModels()).resolves.toEqual([
      { id: 'cursor-agent:auto', name: 'Auto', provider: 'cursor-agent' },
      { id: 'cursor-agent:gpt-5.3-codex', name: 'Codex 5.3', provider: 'cursor-agent' },
    ]);
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      'cursor-agent',
      ['--list-models'],
      expect.objectContaining({ encoding: 'utf8', timeout: 15_000 }),
      expect.any(Function),
    );
  });
});
