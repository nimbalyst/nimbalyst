import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ProviderFactory } from '../../ProviderFactory';
import { configureMcpServers } from '../../services/mcpServerConfig';
import { ClaudeCodeDeps } from '../claudeCode/dependencyInjection';

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

/**
 * #1177 — the git snapshot is the other mutable thing near the head of the
 * prompt. The CLI regenerated it from the live working tree on every resumed
 * turn, which invalidated the entire message prefix behind it (62.8% full
 * rewrite on resume turns vs 0.4% in-process). Nimbalyst now injects its own
 * snapshot, so it has to obey the same freeze invariant the naming decision
 * does: resolved once per session, then never re-read.
 */
describe('ClaudeCodeProvider frozen git context (#1177)', () => {
  beforeAll(() => {
    configureMcpServers({ mcpServerPort: 12345 });
  });

  afterAll(() => {
    configureMcpServers({ mcpServerPort: null });
  });

  afterEach(() => {
    ClaudeCodeDeps.gitContextLoader = null;
  });

  type GitProvider = {
    buildSystemPrompt(documentContext?: { hasBeenNamed?: boolean }): string;
    ensureGitContext(workspacePath?: string): Promise<void>;
  };

  function createProvider(sessionId: string): GitProvider {
    return ProviderFactory.createProvider('claude-code', sessionId) as unknown as GitProvider;
  }

  it('renders the resolved snapshot once and keeps it byte-identical when the tree moves', async () => {
    const sessionId = 'git-context-frozen';
    let call = 0;
    ClaudeCodeDeps.gitContextLoader = async () => `Current branch: branch-${++call}`;
    const provider = createProvider(sessionId);
    try {
      await provider.ensureGitContext('/tmp/workspace');
      const turn1 = provider.buildSystemPrompt({ hasBeenNamed: false });
      // Turn 2: the agent has edited files and switched branch, so a fresh
      // resolve would return different text. The frozen value must win.
      await provider.ensureGitContext('/tmp/workspace');
      const turn2 = provider.buildSystemPrompt({ hasBeenNamed: true });

      expect(turn1).toContain('Current branch: branch-1');
      expect(call).toBe(1);
      expect(turn2).toBe(turn1);
    } finally {
      ProviderFactory.destroyProvider(sessionId, 'claude-code');
    }
  });

  it('freezes to no git context when the first resolve fails, and does not acquire one later', async () => {
    const sessionId = 'git-context-failed';
    let call = 0;
    ClaudeCodeDeps.gitContextLoader = async () => {
      if (++call === 1) throw new Error('git status timed out');
      return 'Current branch: main';
    };
    const provider = createProvider(sessionId);
    try {
      await provider.ensureGitContext('/tmp/workspace');
      const turn1 = provider.buildSystemPrompt({ hasBeenNamed: false });
      await provider.ensureGitContext('/tmp/workspace');
      const turn2 = provider.buildSystemPrompt({ hasBeenNamed: true });

      expect(turn1).not.toContain('Current branch');
      expect(turn2).toBe(turn1);
    } finally {
      ProviderFactory.destroyProvider(sessionId, 'claude-code');
    }
  });
});
