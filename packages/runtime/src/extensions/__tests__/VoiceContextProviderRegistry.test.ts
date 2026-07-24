import { afterEach, describe, expect, it } from 'vitest';
import {
  registerVoiceContextProvider,
  unregisterVoiceContextProvidersForExtension,
  collectVoiceSessionContext,
  _clearVoiceContextProvidersForTest,
} from '../VoiceContextProviderRegistry';

afterEach(() => {
  _clearVoiceContextProvidersForTest();
});

describe('VoiceContextProviderRegistry', () => {
  it('returns empty string when no providers are registered', async () => {
    expect(await collectVoiceSessionContext({})).toBe('');
  });

  it('concatenates provider output, highest priority first', async () => {
    registerVoiceContextProvider({ id: 'low', priority: 1, provideContext: () => 'LOW' }, 'ext.a');
    registerVoiceContextProvider({ id: 'high', priority: 10, provideContext: async () => 'HIGH' }, 'ext.b');

    expect(await collectVoiceSessionContext({})).toBe('HIGH\n\nLOW');
  });

  it('passes the session input through to providers', async () => {
    let received: unknown;
    registerVoiceContextProvider(
      { id: 'capture', provideContext: (input) => { received = input; return 'ok'; } },
      'ext.a'
    );
    await collectVoiceSessionContext({ workspacePath: '/ws', voiceSessionId: 'v1', codingSessionId: 'c1' });
    expect(received).toEqual({ workspacePath: '/ws', voiceSessionId: 'v1', codingSessionId: 'c1' });
  });

  it('isolates a throwing provider so the others still contribute', async () => {
    registerVoiceContextProvider({ id: 'boom', provideContext: () => { throw new Error('nope'); } }, 'ext.a');
    registerVoiceContextProvider({ id: 'ok', provideContext: () => 'survived' }, 'ext.b');

    expect(await collectVoiceSessionContext({})).toBe('survived');
  });

  it('caps each provider and the total output', async () => {
    registerVoiceContextProvider(
      { id: 'big', provideContext: () => 'x'.repeat(5000) },
      'ext.a'
    );
    const out = await collectVoiceSessionContext({}, { perProviderChars: 100, totalChars: 200 });
    expect(out.length).toBeLessThanOrEqual(100 + '… (truncated)'.length);
    expect(out).toContain('… (truncated)');
  });

  it('disposing the registration removes the provider', async () => {
    const disposable = registerVoiceContextProvider({ id: 'temp', provideContext: () => 'TEMP' }, 'ext.a');
    expect(await collectVoiceSessionContext({})).toBe('TEMP');
    disposable.dispose();
    expect(await collectVoiceSessionContext({})).toBe('');
  });

  it('unregisters all providers for an extension', async () => {
    registerVoiceContextProvider({ id: 'a', provideContext: () => 'A' }, 'ext.x');
    registerVoiceContextProvider({ id: 'b', provideContext: () => 'B' }, 'ext.x');
    registerVoiceContextProvider({ id: 'c', provideContext: () => 'C' }, 'ext.y');

    unregisterVoiceContextProvidersForExtension('ext.x');
    expect(await collectVoiceSessionContext({})).toBe('C');
  });
});
