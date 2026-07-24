import { describe, expect, it } from 'vitest';
import { applyDeepSeekClaudeAgentProfile, DEEPSEEK_CLAUDE_AGENT_MODEL_ID, DEEPSEEK_CLAUDE_BACKEND_ID, isDeepSeekClaudeBackend, normalizeDeepSeekEffort } from '../deepSeekClaudeAgent';

describe('DeepSeek Claude Agent launch profile', () => {
  it('atomically maps the picker model to a supported backend and real DOFs', () => {
    expect(applyDeepSeekClaudeAgentProfile({ model: DEEPSEEK_CLAUDE_AGENT_MODEL_ID, effortLevel: 'low', thinkingMode: 'disabled' })).toEqual({ model: DEEPSEEK_CLAUDE_AGENT_MODEL_ID, customBackend: DEEPSEEK_CLAUDE_BACKEND_ID, effortLevel: 'high', thinkingMode: 'disabled' });
  });
  it('normalizes legacy effort values to High or Max', () => {
    expect(normalizeDeepSeekEffort('low')).toBe('high');
    expect(normalizeDeepSeekEffort('medium')).toBe('high');
    expect(normalizeDeepSeekEffort('xhigh')).toBe('max');
    expect(normalizeDeepSeekEffort('max')).toBe('max');
  });
  it('keeps retired backend ids readable as the canonical V4 profile', () => {
    expect(isDeepSeekClaudeBackend('deepseek-chat')).toBe(true);
    expect(isDeepSeekClaudeBackend('deepseek-reasoner')).toBe(true);
    expect(applyDeepSeekClaudeAgentProfile({ model: 'claude-code:sonnet', customBackend: 'deepseek-reasoner', effortLevel: 'xhigh' }).customBackend).toBe(DEEPSEEK_CLAUDE_BACKEND_ID);
  });

  it('keeps high effort as high', () => expect(normalizeDeepSeekEffort('high')).toBe('high'));
  it('enables reasoning by default', () => expect(applyDeepSeekClaudeAgentProfile({ model: DEEPSEEK_CLAUDE_AGENT_MODEL_ID }).thinkingMode).toBe('enabled'));
  it('keeps explicit enabled reasoning', () => expect(applyDeepSeekClaudeAgentProfile({ model: DEEPSEEK_CLAUDE_AGENT_MODEL_ID, thinkingMode: 'enabled' }).thinkingMode).toBe('enabled'));
  it('recognizes the synthetic model variant', () => expect(applyDeepSeekClaudeAgentProfile({ model: 'deepseek' }).customBackend).toBe(DEEPSEEK_CLAUDE_BACKEND_ID));
  it('does not change an ordinary Claude Agent model', () => expect(applyDeepSeekClaudeAgentProfile({ model: 'claude-code:sonnet' }).customBackend).toBeUndefined());
});
