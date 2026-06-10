import { describe, it, expect } from 'vitest';
import { ClaudeCodeProvider } from '@nimbalyst/runtime/ai/server/providers/ClaudeCodeProvider';
import {
  DEFAULT_CLAUDE_CODE_ENABLED_MODELS,
  insertClaudeCodeVariant,
} from '../claudeCodeModelDefaults';

/**
 * Mirrors the claude-code model-id gate inside `AIService` `ai:getModels`
 * (the `provider.models` filter). A row only reaches the picker when its id is
 * in the enabled list, or it's a `-1m` row whose base id is enabled. Replayed
 * here so we can prove Fable 5 survives the gate without standing up the full
 * IPC handler. Keep in sync with AIService if that filter changes.
 */
function survivesPickerGate(modelId: string, enabled: readonly string[]): boolean {
  if (enabled.length === 0) return true;
  if (enabled.includes(modelId)) return true;
  if (modelId.includes('-1m') && enabled.includes(modelId.replace(/-1m$/, ''))) return true;
  return false;
}

describe('DEFAULT_CLAUDE_CODE_ENABLED_MODELS', () => {
  it('seeds Fable 5 ahead of opus for fresh installs', () => {
    expect(DEFAULT_CLAUDE_CODE_ENABLED_MODELS).toContain('claude-code:fable-5');
    expect(DEFAULT_CLAUDE_CODE_ENABLED_MODELS.indexOf('claude-code:fable-5')).toBeLessThan(
      DEFAULT_CLAUDE_CODE_ENABLED_MODELS.indexOf('claude-code:opus'),
    );
  });
});

describe('insertClaudeCodeVariant (existing-user migration)', () => {
  // A list as it would have been persisted before Fable 5 shipped.
  const legacy = [
    'claude-code:opus',
    'claude-code:opus-4-7',
    'claude-code:opus-4-6',
    'claude-code:sonnet',
    'claude-code:haiku',
  ];

  it('back-fills Fable 5 immediately before opus', () => {
    const result = insertClaudeCodeVariant(legacy, 'claude-code:fable-5', 'claude-code:opus', 'before');
    expect(result.indexOf('claude-code:fable-5')).toBe(result.indexOf('claude-code:opus') - 1);
  });

  it('is idempotent — a list that already has the variant is unchanged', () => {
    const once = insertClaudeCodeVariant(legacy, 'claude-code:fable-5', 'claude-code:opus', 'before');
    const twice = insertClaudeCodeVariant(once, 'claude-code:fable-5', 'claude-code:opus', 'before');
    expect(twice).toEqual(once);
  });

  it('does not mutate the input list', () => {
    const snapshot = [...legacy];
    insertClaudeCodeVariant(legacy, 'claude-code:fable-5', 'claude-code:opus', 'before');
    expect(legacy).toEqual(snapshot);
  });

  it("defaults 'after' insertion and falls back to the end when the anchor is missing", () => {
    const result = insertClaudeCodeVariant(legacy, 'claude-code:fable-5', 'claude-code:nope');
    expect(result[result.length - 1]).toBe('claude-code:fable-5');
  });

  it("'before' insertion falls back to the front when the anchor is missing", () => {
    const result = insertClaudeCodeVariant(legacy, 'claude-code:fable-5', 'claude-code:nope', 'before');
    expect(result[0]).toBe('claude-code:fable-5');
  });
});

describe('Fable 5 picker visibility (catalog filtered by enabled list)', () => {
  it('Fable 5 rows from the real catalog survive the default enabled list', async () => {
    const ids = (await ClaudeCodeProvider.getModels()).map((m) => m.id);
    const visible = ids.filter((id) => survivesPickerGate(id, DEFAULT_CLAUDE_CODE_ENABLED_MODELS));
    expect(visible).toContain('claude-code:fable-5');
    expect(visible).toContain('claude-code:fable-5-1m');
  });

  it('regression guard: a pre-Fable enabled list hides both rows', async () => {
    // This is the bug the fix closes: catalog had the rows, but the enabled
    // list (default or migrated) did not, so the gate dropped them.
    const preFable = [
      'claude-code:opus',
      'claude-code:opus-4-7',
      'claude-code:opus-4-6',
      'claude-code:sonnet',
      'claude-code:haiku',
    ];
    const ids = (await ClaudeCodeProvider.getModels()).map((m) => m.id);
    const visible = ids.filter((id) => survivesPickerGate(id, preFable));
    expect(visible).not.toContain('claude-code:fable-5');
    expect(visible).not.toContain('claude-code:fable-5-1m');
  });
});
