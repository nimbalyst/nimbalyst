import { describe, expect, it } from 'vitest';
import { resolveClaudeCodeSessionRoute } from '../ClaudeCodeSessionRoute';

const OLLAMA_MODEL = 'claude-code:ollama-glm-5-2-cloud';

describe('Claude Code persisted session routing', () => {
  it('resolves the exact persisted Ollama identity on a fresh read', async () => {
    const result = await resolveClaudeCodeSessionRoute(
      'session-1',
      OLLAMA_MODEL,
      undefined,
      async () => ({ model: OLLAMA_MODEL, workspacePath: 'D:/workspace' })
    );

    expect(result.model).toBe(OLLAMA_MODEL);
    expect(result.backend?.id).toBe('ollama-glm-5-2-cloud');
    expect(result.workspacePath).toBe('D:/workspace');
  });

  it.each([
    'claude-code:claudex-sol',
    'claude-code:openrouter-deepseek-v4-flash',
  ])('passes valid general catalog identity %s to the runtime resolver', async (model) => {
    const result = await resolveClaudeCodeSessionRoute(
      'session-general',
      model,
      undefined,
      async () => ({ model, workspacePath: 'D:/workspace' }),
    );

    expect(result).toMatchObject({
      model,
      backend: undefined,
      workspacePath: 'D:/workspace',
    });
  });

  it('fails closed when an Ollama session persistence read fails', async () => {
    await expect(resolveClaudeCodeSessionRoute(
      'session-1',
      OLLAMA_MODEL,
      undefined,
      async () => { throw new Error('database offline'); }
    )).rejects.toThrow('cannot refresh its persisted model identity');
  });

  it('fails closed when an Ollama session row disappears', async () => {
    await expect(resolveClaudeCodeSessionRoute(
      'session-1',
      OLLAMA_MODEL,
      undefined,
      async () => null
    )).rejects.toThrow('has no persisted session row');
  });

  it('fails closed when the persisted Ollama identity is replaced by Sonnet', async () => {
    await expect(resolveClaudeCodeSessionRoute(
      'session-1',
      OLLAMA_MODEL,
      undefined,
      async () => ({ model: 'claude-code:sonnet' })
    )).rejects.toThrow('persisted model identity changed or was lost');
  });

  it('rejects a corrupt lookalike persisted Ollama identity', async () => {
    await expect(resolveClaudeCodeSessionRoute(
      'session-1',
      OLLAMA_MODEL,
      undefined,
      async () => ({ model: 'claude-code:ollama-similar' })
    )).rejects.toThrow('Unsupported catalog-owned Claude Code model identity');
  });

  it('preserves the ordinary-session fallback when persistence is unavailable', async () => {
    const result = await resolveClaudeCodeSessionRoute(
      'session-2',
      'claude-code:opus',
      { effortLevel: 'high' },
      async () => { throw new Error('database offline'); }
    );

    expect(result).toEqual({
      model: 'claude-code:opus',
      metadata: { effortLevel: 'high' },
      backend: undefined,
      workspacePath: undefined,
    });
  });
});
