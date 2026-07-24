import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ProviderFactory } from '../../ProviderFactory';
import { configureMcpServers } from '../../services/mcpServerConfig';

/**
 * NIM-1988 — claude-code names sessions in-band via update_session_meta after
 * the SDK's paid generateSessionTitle side-request was removed. A fresh session
 * must be told to name itself; a session already named out-of-band (e.g. a
 * spawn_session child titled by its parent, hasBeenNamed=true) must be told NOT
 * to, so it doesn't clobber that title.
 */
describe('ClaudeCodeProvider in-band session naming (NIM-1988)', () => {
  beforeAll(() => {
    // hasSessionNaming is gated on the internal MCP server being up; simulate it
    // so the naming section is included in the built prompt.
    configureMcpServers({ mcpServerPort: 12345 });
  });

  afterAll(() => {
    configureMcpServers({ mcpServerPort: null });
  });

  function buildPrompt(sessionId: string, hasBeenNamed: boolean | undefined): string {
    const provider = ProviderFactory.createProvider('claude-code', sessionId) as unknown as {
      buildSystemPrompt(documentContext?: { hasBeenNamed?: boolean }): string;
    };
    try {
      return provider.buildSystemPrompt({ hasBeenNamed });
    } finally {
      ProviderFactory.destroyProvider(sessionId, 'claude-code');
    }
  }

  it('tells an unnamed session to name itself in-band', () => {
    const prompt = buildPrompt('naming-unnamed', false);
    expect(prompt).toContain('### Name guidelines');
    expect(prompt).toContain('CRITICAL: You MUST call this tool');
    expect(prompt).not.toContain('do NOT set `name`');
  });

  it('defaults to in-band naming when hasBeenNamed is absent', () => {
    const prompt = buildPrompt('naming-absent', undefined);
    expect(prompt).toContain('CRITICAL: You MUST call this tool');
    expect(prompt).not.toContain('do NOT set `name`');
  });

  it('suppresses self-naming for a session already named out-of-band', () => {
    const prompt = buildPrompt('naming-preset', true);
    expect(prompt).toContain('do NOT set `name`');
    expect(prompt).not.toContain('### Name guidelines');
  });

  // Cache safety: the appended system prompt is re-sent every turn, so the
  // naming section must be byte-stable for the life of the session. If the
  // agent names itself in-band on turn 1 (hasBeenNamed flips false->true), the
  // decision must NOT flip on turn 2 or the whole prompt cache is invalidated.
  it('keeps the naming instruction stable after the session gets named mid-session', () => {
    const sessionId = 'naming-stable';
    const provider = ProviderFactory.createProvider('claude-code', sessionId) as unknown as {
      buildSystemPrompt(documentContext?: { hasBeenNamed?: boolean }): string;
    };
    try {
      const turn1 = provider.buildSystemPrompt({ hasBeenNamed: false });
      // Simulate the agent having named the session in-band during turn 1.
      const turn2 = provider.buildSystemPrompt({ hasBeenNamed: true });

      expect(turn1).toContain('CRITICAL: You MUST call this tool');
      // The appended system prompt is re-sent every turn and sits at the front
      // of the prompt-cache prefix. Byte-for-byte equality across turns is the
      // real cache invariant — any drift (naming flip, timestamps, ordering)
      // would force a system_changed miss on turn 2.
      expect(turn2).toBe(turn1);
    } finally {
      ProviderFactory.destroyProvider(sessionId, 'claude-code');
    }
  });
});
