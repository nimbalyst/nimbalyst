// @vitest-environment node
//
// The regression these guard is the one a reader cannot see: an empty catalog
// used to be the trigger for falling through to the NEXT provider's catalog,
// and "unsupported" was indistinguishable from "supported, nothing yet".

import { describe, expect, it, vi } from 'vitest';
import type { AIProvider } from '@nimbalyst/runtime/ai/server/AIProvider';
import type { AgentCapabilities } from '@nimbalyst/runtime/ai/server/agentCapabilities';
import { resolveProviderWorkflowCatalog } from '../providerWorkflowCatalog';

function fakeProvider(
  capabilities: AgentCapabilities,
  catalog: { commands?: string[]; skills?: string[] } = {},
): AIProvider {
  return {
    getAgentCapabilities: () => capabilities,
    getSlashCommands: () => catalog.commands ?? [],
    getSkills: () => catalog.skills ?? [],
  } as unknown as AIProvider;
}

describe('resolveProviderWorkflowCatalog', () => {
  it('reports an unsupported capability and an empty one differently', () => {
    const unsupported = resolveProviderWorkflowCatalog('openai-codex', {
      instance: fakeProvider({ slashCommands: false, skills: true, compaction: 'rpc', contextReporting: 'context-window', midTurnInput: false }),
    });
    const empty = resolveProviderWorkflowCatalog('claude-code', {
      instance: fakeProvider({ slashCommands: true, skills: true, compaction: 'slash-command', contextReporting: 'context-window', midTurnInput: false }),
    });

    expect(unsupported.commands).toEqual([]);
    expect(empty.commands).toEqual([]);
    // Same data, opposite meanings -- the declaration is what tells them apart.
    expect(unsupported.capabilities.slashCommands).toBe(false);
    expect(empty.capabilities.slashCommands).toBe(true);
  });

  it('does not read the catalog of a capability the provider does not declare', () => {
    const getSlashCommands = vi.fn(() => ['leftover-from-a-previous-transport']);
    const provider = {
      getAgentCapabilities: () => ({ slashCommands: false, skills: true, compaction: 'rpc', contextReporting: 'context-window', midTurnInput: false }),
      getSlashCommands,
      getSkills: () => ['deep-research'],
    } as unknown as AIProvider;

    const catalog = resolveProviderWorkflowCatalog('openai-codex', { instance: provider });

    expect(catalog.commands).toEqual([]);
    expect(catalog.skills).toEqual(['deep-research']);
  });

  it('never substitutes a cached catalog for a provider that declares nothing', () => {
    // The old ladder did exactly this: an empty result from an agent provider
    // fell through to claude-code's cached SDK commands.
    const cachedCatalog = vi.fn(() => ({ commands: ['compact', 'context'], skills: ['review'] }));

    const codex = resolveProviderWorkflowCatalog('openai-codex-acp', { cachedCatalog });
    expect(codex.commands).toEqual([]);
    expect(codex.skills).toEqual([]);
    expect(cachedCatalog).not.toHaveBeenCalled();

    // claude-code declares both, so its own cache is legitimately consulted.
    const claude = resolveProviderWorkflowCatalog('claude-code', { cachedCatalog });
    expect(claude.commands).toEqual(['compact', 'context']);
    expect(claude.skills).toEqual(['review']);
  });

  it('fails closed for an unknown provider id', () => {
    const catalog = resolveProviderWorkflowCatalog('some-extension-agent');

    expect(catalog.capabilities).toEqual({
      slashCommands: false,
      skills: false,
      compaction: 'unsupported',
      contextReporting: 'none',
      midTurnInput: false,
    });
  });
});
