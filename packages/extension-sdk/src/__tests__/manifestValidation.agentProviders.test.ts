import { describe, it, expect } from 'vitest';
import { validateAgentProviders } from '../manifestValidation';

// The validator must agree with the AiAgentProviderContribution /
// AiAgentProviderModel types: the provider label field is `displayName`, and
// model entries carry no per-entry `provider`. A manifest matching the shipped
// gemini-antigravity contribution should pass cleanly. Before the alignment,
// the validator required `name` and `model.provider`, so the real manifest
// failed its own validator (#558 review, point 1).
const backendModules = [{ id: 'antigravity-server', entry: 'backend/index.js' }];

function geminiLikeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'antigravity-gemini-agent',
    displayName: 'Gemini',
    platform: 'antigravity-gemini',
    backendModuleId: 'antigravity-server',
    modelDiscovery: 'static',
    models: [
      { id: 'antigravity-gemini-agent:gemini-3-flash-agent', name: 'Gemini 3.5 Flash (High)', default: true },
      { id: 'antigravity-gemini-agent:gemini-3.5-flash-low', name: 'Gemini 3.5 Flash (Medium)' },
    ],
    ...overrides,
  };
}

describe('validateAgentProviders - alignment with the SDK type (#558)', () => {
  it('accepts a provider that uses displayName and models without a provider field', () => {
    const issues = validateAgentProviders([geminiLikeProvider()], backendModules);
    expect(issues).toEqual([]);
  });

  it('flags a provider missing displayName', () => {
    const { displayName, ...noDisplayName } = geminiLikeProvider();
    const issues = validateAgentProviders([noDisplayName], backendModules);
    expect(issues.some((i) => i.message.includes('displayName'))).toBe(true);
  });

  it('does not require a per-model provider field', () => {
    // A model entry with only id + name is valid; the host derives the
    // provider from the contribution id.
    const issues = validateAgentProviders(
      [geminiLikeProvider({ models: [{ id: 'm1', name: 'Model One' }] })],
      backendModules
    );
    expect(issues).toEqual([]);
  });

  it('still requires a model name', () => {
    const issues = validateAgentProviders(
      [geminiLikeProvider({ models: [{ id: 'm1' }] })],
      backendModules
    );
    expect(issues.some((i) => i.message.includes('.name must be a non-empty string'))).toBe(true);
  });
});
