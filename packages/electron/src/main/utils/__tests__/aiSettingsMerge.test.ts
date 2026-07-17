import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getAIProviderOverridesMock, resolveProjectPathMock } = vi.hoisted(() => ({
  getAIProviderOverridesMock: vi.fn(),
  resolveProjectPathMock: vi.fn((workspacePath: string) => workspacePath),
}));

vi.mock('../store', async () => {
  const actual = await vi.importActual<typeof import('../store')>('../store');
  return {
    ...actual,
    getAIProviderOverrides: getAIProviderOverridesMock,
  };
});

vi.mock('../workspaceDetection', () => ({
  resolveProjectPath: resolveProjectPathMock,
}));

import { mergeAISettings, GlobalAISettings } from '../aiSettingsMerge';
import { normalizeAIProviderOverrides } from '../store';

const baseGlobal: GlobalAISettings = {
  defaultProvider: 'claude-code',
  apiKeys: {},
  providerSettings: {},
  showToolCalls: false,
  aiDebugLogging: false,
  showPromptAdditions: false,
  customClaudeCodePath: '/usr/local/bin/claude-global',
};

describe('mergeAISettings -- customClaudeCodePath', () => {
  beforeEach(() => {
    getAIProviderOverridesMock.mockReset();
    resolveProjectPathMock.mockReset();
    resolveProjectPathMock.mockImplementation((workspacePath: string) => workspacePath);
  });

  it('inherits the global path when no project override is set', () => {
    getAIProviderOverridesMock.mockReturnValue(undefined);

    const effective = mergeAISettings(baseGlobal, '/workspace/a');

    expect(effective.customClaudeCodePath).toBe('/usr/local/bin/claude-global');
    expect(effective.overrides.customClaudeCodePath).toBe(false);
  });

  it('uses the project override when set, marking it as overridden', () => {
    getAIProviderOverridesMock.mockReturnValue({
      customClaudeCodePath: '/opt/project/claude',
    });

    const effective = mergeAISettings(baseGlobal, '/workspace/a');

    expect(effective.customClaudeCodePath).toBe('/opt/project/claude');
    expect(effective.overrides.customClaudeCodePath).toBe(true);
  });

  it('treats an empty-string override as an explicit override (use bundled SDK)', () => {
    getAIProviderOverridesMock.mockReturnValue({
      customClaudeCodePath: '',
    });

    const effective = mergeAISettings(baseGlobal, '/workspace/a');

    expect(effective.customClaudeCodePath).toBe('');
    expect(effective.overrides.customClaudeCodePath).toBe(true);
  });

  it('returns the global path unchanged when no workspace path is provided', () => {
    const effective = mergeAISettings(baseGlobal, undefined);

    expect(effective.customClaudeCodePath).toBe('/usr/local/bin/claude-global');
    expect(effective.overrides.customClaudeCodePath).toBe(false);
    expect(getAIProviderOverridesMock).not.toHaveBeenCalled();
  });

  it('inherits the parent project override when the workspace path is a worktree', () => {
    resolveProjectPathMock.mockReturnValue('/workspace/project');
    getAIProviderOverridesMock.mockImplementation((workspacePath: string) => {
      if (workspacePath === '/workspace/project') {
        return { customClaudeCodePath: '/opt/project/claude' };
      }
      return undefined;
    });

    const effective = mergeAISettings(baseGlobal, '/workspace/project_worktrees/swift-falcon');

    expect(effective.customClaudeCodePath).toBe('/opt/project/claude');
    expect(effective.overrides.customClaudeCodePath).toBe(true);
  });
});

describe('normalizeAIProviderOverrides', () => {
  it('collapses to undefined when only an empty codex provider is present', () => {
    const result = normalizeAIProviderOverrides({
      providers: { 'openai-codex': {} },
    });

    expect(result).toBeUndefined();
  });

  it('drops an empty codex entry while preserving other override fields', () => {
    const result = normalizeAIProviderOverrides({
      providers: { 'openai-codex': {} },
      customClaudeCodePath: '/opt/project/claude',
    });

    expect(result).toEqual({ customClaudeCodePath: '/opt/project/claude' });
    expect(result && 'providers' in result).toBe(false);
  });

  it('strips own-but-undefined customClaudeCodePath so an otherwise-empty override collapses', () => {
    const input: Record<string, unknown> = {
      providers: { 'openai-codex': {} },
      customClaudeCodePath: undefined,
    };

    const result = normalizeAIProviderOverrides(input as any);

    expect(result).toBeUndefined();
  });
});
