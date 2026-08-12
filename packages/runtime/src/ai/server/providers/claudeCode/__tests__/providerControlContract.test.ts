// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  ProviderControlContractError,
  resolveProviderControlSnapshot,
  serializeProviderControlSnapshot,
  type ProviderControlCatalogEntry,
} from '../providerControlContract';

const reviewedEntry: ProviderControlCatalogEntry = {
  id: 'reviewed-model',
  provider: 'reviewed-provider',
  modelId: 'reviewed/model-v1',
  interfaces: ['claude-agent-anthropic', 'consultation-launcher'],
  consumers: ['main-session', 'subagent', 'consultation'],
  controls: [
    {
      id: 'reasoning-profile',
      settingId: 'reasoning.profile',
      type: 'profile',
      label: 'Reasoning profile',
      helpText: 'Choose a reviewed reasoning profile.',
      defaultValue: 'think-high',
      allowedValues: ['off', 'think-high', 'think-max'],
      applicability: { launch: true, restart: true, 'mid-session': false },
      mappings: [
        {
          interfaceId: 'claude-agent-anthropic',
          target: 'request.thinking.type',
          values: [
            { storedValue: 'off', resolvedValue: 'disabled' },
            { storedValue: 'think-high', resolvedValue: 'enabled' },
            { storedValue: 'think-max', resolvedValue: 'enabled' },
          ],
        },
        {
          interfaceId: 'claude-agent-anthropic',
          target: 'request.output_config.effort',
          values: [
            { storedValue: 'off', operation: 'omit' },
            { storedValue: 'think-high', resolvedValue: 'high' },
            { storedValue: 'think-max', resolvedValue: 'max' },
          ],
        },
        {
          interfaceId: 'consultation-launcher',
          target: 'launcher.profile',
          values: [
            { storedValue: 'off', resolvedValue: 'reviewed-model-off' },
            { storedValue: 'think-high', resolvedValue: 'reviewed-model-high' },
            { storedValue: 'think-max', resolvedValue: 'reviewed-model-max' },
          ],
        },
      ],
    },
  ],
};

function expectContractError(run: () => unknown, code: ProviderControlContractError['code']) {
  try {
    run();
    throw new Error('Expected contract error');
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderControlContractError);
    expect((error as ProviderControlContractError).code).toBe(code);
  }
}

describe('providerControlContract', () => {
  it('resolves and freezes an exact parameter snapshot without fallback', () => {
    const snapshot = resolveProviderControlSnapshot({
      catalog: [reviewedEntry],
      catalogEntryId: reviewedEntry.id,
      interfaceId: 'claude-agent-anthropic',
      consumer: 'main-session',
      phase: 'launch',
      requested: { 'reasoning.profile': 'think-max' },
    });

    expect(snapshot).toEqual({
      schemaVersion: 1,
      catalogEntryId: 'reviewed-model',
      provider: 'reviewed-provider',
      modelId: 'reviewed/model-v1',
      interfaceId: 'claude-agent-anthropic',
      consumer: 'main-session',
      phase: 'launch',
      requested: { 'reasoning.profile': 'think-max' },
      resolved: { 'reasoning.profile': 'think-max' },
      parameters: [
        {
          controlId: 'reasoning-profile',
          settingId: 'reasoning.profile',
          interfaceId: 'claude-agent-anthropic',
          target: 'request.thinking.type',
          operation: 'set',
          value: 'enabled',
        },
        {
          controlId: 'reasoning-profile',
          settingId: 'reasoning.profile',
          interfaceId: 'claude-agent-anthropic',
          target: 'request.output_config.effort',
          operation: 'set',
          value: 'max',
        },
      ],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.parameters)).toBe(true);
    expect(serializeProviderControlSnapshot(snapshot)).toBe(JSON.stringify(snapshot));
  });

  it('resolves the reviewed consultation profile rather than inventing a route', () => {
    const snapshot = resolveProviderControlSnapshot({
      catalog: [reviewedEntry],
      catalogEntryId: reviewedEntry.id,
      interfaceId: 'consultation-launcher',
      consumer: 'consultation',
      phase: 'launch',
    });

    expect(snapshot.parameters).toEqual([
      expect.objectContaining({ target: 'launcher.profile', value: 'reviewed-model-high' }),
    ]);
  });

  it('rejects missing entries, interfaces, consumers, and stale settings', () => {
    expectContractError(() => resolveProviderControlSnapshot({
      catalog: [reviewedEntry],
      catalogEntryId: 'nearby-model',
      interfaceId: 'claude-agent-anthropic',
      consumer: 'main-session',
      phase: 'launch',
    }), 'route-not-found');
    expectContractError(() => resolveProviderControlSnapshot({
      catalog: [reviewedEntry],
      catalogEntryId: reviewedEntry.id,
      interfaceId: 'unknown-adapter',
      consumer: 'main-session',
      phase: 'launch',
    }), 'unsupported-interface');
    expectContractError(() => resolveProviderControlSnapshot({
      catalog: [{ ...reviewedEntry, consumers: ['main-session'] }],
      catalogEntryId: reviewedEntry.id,
      interfaceId: 'claude-agent-anthropic',
      consumer: 'subagent',
      phase: 'launch',
    }), 'unsupported-consumer');
    expectContractError(() => resolveProviderControlSnapshot({
      catalog: [reviewedEntry],
      catalogEntryId: reviewedEntry.id,
      interfaceId: 'claude-agent-anthropic',
      consumer: 'main-session',
      phase: 'launch',
      requested: { 'old.hidden.setting': true },
    }), 'invalid-controls');
  });

  it('rejects unsupported values and start-only changes', () => {
    expectContractError(() => resolveProviderControlSnapshot({
      catalog: [reviewedEntry],
      catalogEntryId: reviewedEntry.id,
      interfaceId: 'claude-agent-anthropic',
      consumer: 'main-session',
      phase: 'launch',
      requested: { 'reasoning.profile': 'turbo' },
    }), 'invalid-controls');
    expectContractError(() => resolveProviderControlSnapshot({
      catalog: [reviewedEntry],
      catalogEntryId: reviewedEntry.id,
      interfaceId: 'claude-agent-anthropic',
      consumer: 'main-session',
      phase: 'mid-session',
      requested: { 'reasoning.profile': 'think-max' },
    }), 'invalid-controls');
  });

  it('rejects executable or unreviewed catalog shapes at the boundary', () => {
    const unsafe = {
      ...reviewedEntry,
      controls: [{
        ...reviewedEntry.controls[0],
        mappings: [{
          interfaceId: 'claude-agent-anthropic',
          target: 'shell.command',
          values: [{ storedValue: 'think-high', resolvedValue: 'curl secret' }],
        }],
      }],
    } as unknown as ProviderControlCatalogEntry;
    expectContractError(() => resolveProviderControlSnapshot({
      catalog: [unsafe],
      catalogEntryId: unsafe.id,
      interfaceId: 'claude-agent-anthropic',
      consumer: 'main-session',
      phase: 'launch',
    }), 'invalid-catalog');
  });
});
