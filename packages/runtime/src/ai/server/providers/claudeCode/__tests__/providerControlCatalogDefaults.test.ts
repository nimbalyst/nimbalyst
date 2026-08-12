// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { getBuiltInProviderControlEntry, reconcileBuiltInProviderControlValues } from '../providerControlCatalogDefaults';
import { resolveProviderControlSnapshot } from '../providerControlContract';

describe('built-in provider control catalog', () => {
  it('declares only reviewed Claude and paired launcher controls without nearby fallback', () => {
    expect(getBuiltInProviderControlEntry('claude-code:opus')?.controls.map((control) => control.settingId)).toEqual([
      'effort-level',
      'thinking-mode',
    ]);
    expect(getBuiltInProviderControlEntry('openai-codex:gpt-5.6-sol')).toBeUndefined();
    expect(getBuiltInProviderControlEntry('model-launcher:deepseek-pro')?.interfaces).toEqual(['unified-model-launcher']);
    expect(getBuiltInProviderControlEntry('model-launcher:other')).toBeUndefined();
    expect(getBuiltInProviderControlEntry('claude-code:haiku')).toBeUndefined();
  });

  it('resets incompatible model-switch values to the reviewed target default', () => {
    expect(reconcileBuiltInProviderControlValues('model-launcher:deepseek-pro', {
      'effort-level': 'max',
      'thinking-mode': 'disabled',
    })).toEqual({
      values: { 'effort-level': 'high' },
      resets: [{ settingId: 'effort-level', from: 'max', to: 'high' }],
    });
  });

  it('resolves exact DeepSeek launcher effort and rejects unsupported max', () => {
    const entry = getBuiltInProviderControlEntry('model-launcher:deepseek-flash')!;
    const snapshot = resolveProviderControlSnapshot({
      catalog: [entry],
      catalogEntryId: entry.id,
      interfaceId: 'unified-model-launcher',
      consumer: 'consultation',
      phase: 'launch',
      requested: { 'effort-level': 'xhigh' },
    });
    expect(snapshot.parameters).toEqual([
      expect.objectContaining({ target: 'launcher.effort', value: 'xhigh' }),
    ]);
    expect(() => resolveProviderControlSnapshot({
      catalog: [entry],
      catalogEntryId: entry.id,
      interfaceId: 'unified-model-launcher',
      consumer: 'consultation',
      phase: 'launch',
      requested: { 'effort-level': 'max' },
    })).toThrow('unsupported value');
  });
});
