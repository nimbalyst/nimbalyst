// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { AI_PROVIDER_TYPES } from '../types';
import {
  BUILTIN_FILE_CHANGE_FIDELITY,
  PROVIDER_EDIT_TOOL_NAMES,
  attributionModeForFileChangeFidelity,
  attributionModeForProvider,
  fileChangeFidelityForProviderType,
  isProviderEditTool,
} from '../providerFileTracking';

describe('providerFileTracking', () => {
  it('declares fidelity and edit tools for every provider type', () => {
    // The records are exhaustive by type, but a provider added with a
    // placeholder value would still compile. Assert the values are real.
    for (const provider of AI_PROVIDER_TYPES) {
      expect(BUILTIN_FILE_CHANGE_FIDELITY[provider]).toMatch(/^(structured|tool-args|none)$/);
      expect(Array.isArray(PROVIDER_EDIT_TOOL_NAMES[provider])).toBe(true);
    }
  });

  it('only disables watcher attribution for structured file changes', () => {
    expect(attributionModeForFileChangeFidelity('structured')).toBe('disabled');
    expect(attributionModeForFileChangeFidelity('tool-args')).toBe('fuzzy');
    expect(attributionModeForFileChangeFidelity('none')).toBe('fuzzy');
  });

  it('moves Claude Code Bash onto hook windows only when the host has a shell tracker', () => {
    expect(attributionModeForProvider('claude-code', 'tool-args', true)).toBe('shell-window');
    expect(attributionModeForProvider('claude-code', 'tool-args', false)).toBe('fuzzy');
    // The PTY-driven CLI reports no tool calls, so it has no hooks to bracket commands.
    expect(attributionModeForProvider('claude-code-cli', 'none', true)).toBe('fuzzy');
    expect(attributionModeForProvider('opencode', 'tool-args', true)).toBe('fuzzy');
    expect(attributionModeForProvider('openai-codex', 'structured', true)).toBe('disabled');
  });

  it('keeps per-provider edit vocabularies from cross-talking', () => {
    // `create` is OpenCode's; `ApplyPatch` is Codex ACP's. Before this table
    // existed the two lists were separate consts joined by an `||`, so a name
    // added to one could not leak — that property has to survive the merge.
    expect(isProviderEditTool('opencode', 'create')).toBe(true);
    expect(isProviderEditTool('openai-codex-acp', 'create')).toBe(false);
    expect(isProviderEditTool('openai-codex-acp', 'ApplyPatch')).toBe(true);
    expect(isProviderEditTool('opencode', 'ApplyPatch')).toBe(false);
  });

  it('fails closed for providers and tools it does not know', () => {
    expect(isProviderEditTool('some-extension-agent', 'write')).toBe(false);
    expect(isProviderEditTool(null, 'write')).toBe(false);
    expect(isProviderEditTool('opencode', undefined)).toBe(false);
    expect(fileChangeFidelityForProviderType('some-extension-agent')).toBe('none');
    expect(fileChangeFidelityForProviderType(null)).toBe('none');
  });

  it('grants structured fidelity only where an authoritative change item exists', () => {
    // Guards the regression this refactor was for: `'disabled'` attribution is
    // earned by reporting real change data, and every ACP-transport provider
    // is stuck below that bar.
    const structured = AI_PROVIDER_TYPES.filter(
      (p) => BUILTIN_FILE_CHANGE_FIDELITY[p] === 'structured',
    );
    expect(structured).toEqual(['openai-codex', 'cursor-agent']);
  });
});
