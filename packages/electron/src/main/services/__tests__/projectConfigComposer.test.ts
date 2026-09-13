// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  composeProjectConfig,
  hasPublishableConfig,
  toSyncedActionPrompts,
  MAX_ACTION_BODY_CHARS,
  MAX_ACTIONS_TOTAL_CHARS,
  MAX_ACTIONS,
} from '../sync/projectConfigComposer';
import type { ActionPrompt } from '../ActionPromptParser';

const command = { name: 'review', description: 'Review', source: 'project' as const };

function action(id: string, body = 'do the thing', config?: ActionPrompt['config']): ActionPrompt {
  const a: ActionPrompt = { id, label: id, body };
  if (config) a.config = config;
  return a;
}

describe('composeProjectConfig', () => {
  it('keeps commands and actions in the same blob', () => {
    // The regression this guards: two independent producers each sending their
    // own blob, where whoever writes last erases the other's half.
    const config = composeProjectConfig({
      commands: [command],
      lastCommandsUpdate: 100,
      actions: [{ id: 'a', label: 'A', body: 'hello' }],
      lastActionsUpdate: 200,
      gitRemoteHash: 'abc',
    });

    expect(config.commands).toEqual([command]);
    expect(config.actions).toEqual([{ id: 'a', label: 'A', body: 'hello' }]);
    expect(config.lastCommandsUpdate).toBe(100);
    expect(config.lastActionsUpdate).toBe(200);
    expect(config.gitRemoteHash).toBe('abc');
  });

  it('omits the actions key entirely when there are none', () => {
    // An older phone must see byte-identical output to what it saw before this
    // feature existed, and a newer phone must not have to tell [] from absent.
    const config = composeProjectConfig({
      commands: [command],
      lastCommandsUpdate: 100,
      actions: [],
      lastActionsUpdate: 0,
    });

    expect('actions' in config).toBe(false);
    expect('lastActionsUpdate' in config).toBe(false);
  });
});

describe('hasPublishableConfig', () => {
  it('publishes a workspace that has actions but no slash commands', () => {
    // The bug this exists to prevent: the old send site skipped encryption
    // whenever commands were empty, so an actions-only workspace published
    // nothing. Invisible on any repo that happens to have commands.
    const config = composeProjectConfig({
      commands: [],
      lastCommandsUpdate: 0,
      actions: [{ id: 'a', label: 'A', body: 'hello' }],
      lastActionsUpdate: 200,
    });

    expect(hasPublishableConfig(config)).toBe(true);
  });

  it('publishes a workspace that has commands but no actions', () => {
    expect(
      hasPublishableConfig(
        composeProjectConfig({ commands: [command], lastCommandsUpdate: 1, actions: [], lastActionsUpdate: 0 })
      )
    ).toBe(true);
  });

  it('does not publish when both slices are empty even with a git remote hash', () => {
    // gitRemoteHash rides its own plaintext field and does not need the blob.
    expect(
      hasPublishableConfig(
        composeProjectConfig({
          commands: [],
          lastCommandsUpdate: 0,
          actions: [],
          lastActionsUpdate: 0,
          gitRemoteHash: 'abc',
        })
      )
    ).toBe(false);
  });
});

describe('toSyncedActionPrompts', () => {
  it('carries the body verbatim and stays minimal for same-session actions', () => {
    const result = toSyncedActionPrompts([action('review', 'line one\nline two')]);

    expect(result.actions).toEqual([{ id: 'review', label: 'review', body: 'line one\nline two' }]);
  });

  it('carries launch metadata only for launcher actions', () => {
    const result = toSyncedActionPrompts([
      action('plan', 'plan it', {
        launch: 'new-session',
        model: 'claude-code:opus',
        foreground: true,
        autoSubmit: false,
        worktree: true,
      }),
      action('same', 'same it', {
        launch: 'same-session',
        foreground: true,
        autoSubmit: true,
        worktree: false,
      }),
    ]);

    expect(result.actions[0]).toEqual({
      id: 'plan',
      label: 'plan',
      body: 'plan it',
      launch: 'new-session',
      model: 'claude-code:opus',
      autoSubmit: false,
      worktree: true,
    });
    // foreground is a desktop window concept and must never reach the wire.
    expect(result.actions[0]).not.toHaveProperty('foreground');
    // A same-session action carries no launch metadata at all.
    expect(result.actions[1]).toEqual({ id: 'same', label: 'same', body: 'same it' });
  });

  it('truncates an oversized body and flags it', () => {
    const result = toSyncedActionPrompts([action('big', 'x'.repeat(MAX_ACTION_BODY_CHARS + 500))]);

    expect(result.actions[0].body).toHaveLength(MAX_ACTION_BODY_CHARS);
    expect(result.actions[0].truncated).toBe(true);
    expect(result.truncatedCount).toBe(1);
  });

  it('drops whole actions rather than fragments once the total budget is gone', () => {
    const body = 'x'.repeat(MAX_ACTION_BODY_CHARS);
    const count = Math.floor(MAX_ACTIONS_TOTAL_CHARS / MAX_ACTION_BODY_CHARS);
    const actions = Array.from({ length: count + 3 }, (_, i) => action(`a${i}`, body));

    const result = toSyncedActionPrompts(actions);

    expect(result.actions).toHaveLength(count);
    expect(result.droppedForSize).toBe(3);
    // Everything that survived is a complete prompt, not a fragment.
    expect(result.actions.every((a) => a.body.length === MAX_ACTION_BODY_CHARS)).toBe(true);
  });

  it('caps the action count', () => {
    const result = toSyncedActionPrompts(Array.from({ length: MAX_ACTIONS + 5 }, (_, i) => action(`a${i}`, 'x')));

    expect(result.actions).toHaveLength(MAX_ACTIONS);
    expect(result.droppedForCount).toBe(5);
  });
});
