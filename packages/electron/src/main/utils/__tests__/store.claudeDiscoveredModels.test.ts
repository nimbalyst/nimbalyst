// @vitest-environment node
/**
 * The "Detect account models" button saves the models it finds. These tests prove the
 * saved models are still there after Nimbalyst quits and starts again, and that a model
 * the user picked from them still works.
 *
 * How a restart is pretended here: the real settings store (electron-store) writes a real
 * file in a temporary folder. `restartApp()` then throws away every loaded module and loads
 * them again, so nothing stays in memory. Only the file on disk survives, like a real quit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AIModel } from '@nimbalyst/runtime/ai/server/types';

// One settings folder per test. The folder name must not change when modules reload,
// so the electron mock reads it from this object instead of making a new folder itself.
const profile = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: () => profile.dir,
    getName: () => 'test-app',
    getVersion: () => '1.0.0',
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    on: () => {},
    once: () => {},
    off: () => {},
    removeListener: () => {},
    quit: () => {},
  },
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: { send: () => {}, on: () => {}, invoke: () => {} },
}));

// Shortened copy of what Anthropic's model list returns for an account with Claude Mythos.
const ACCOUNT_LIST = {
  data: [
    { id: 'claude-mythos-5-2', display_name: 'Claude Mythos 5.2', line: 'mythos', max_input_tokens: 1_000_000, lifecycle: 'active' },
  ],
};
const MYTHOS_ID = 'claude-code:custom/claude-mythos-5-2';
const BUILT_IN_SONNET: AIModel = {
  id: 'claude-code:sonnet',
  name: 'Claude Agent · Sonnet',
  provider: 'claude-code',
  maxTokens: 8192,
  contextWindow: 200_000,
};

/** Quit and start again: load every module fresh. Only the settings file on disk stays. */
async function restartApp() {
  vi.resetModules();
  return {
    store: await import('../store'),
    custom: await import('@nimbalyst/runtime/ai/claudeCustomModels'),
    accountModels: await import('../../services/ai/claudeAccountModels'),
    identifier: await import('@nimbalyst/runtime/ai/server/ModelIdentifier'),
  };
}

/** The models the Detect button would save for the sample account. */
async function detectedOptions() {
  const { accountModels } = await restartApp();
  return accountModels.toDiscoveredOptions(accountModels.parseAccountModelRows(ACCOUNT_LIST.data));
}

beforeEach(() => {
  profile.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-discovered-models-'));
});

afterEach(() => {
  fs.rmSync(profile.dir, { recursive: true, force: true });
});

describe('detected Claude account models after the app restarts', () => {
  it('are still saved after a restart', async () => {
    const options = await detectedOptions();
    expect(options.map((o) => o.model)).toEqual(['claude-mythos-5-2']);

    const before = await restartApp();
    before.store.setClaudeCodeDiscoveredModels(options);

    const after = await restartApp();
    // Prove the restart really loaded a new copy of the store code.
    expect(after.store.getClaudeCodeDiscoveredModels).not.toBe(before.store.getClaudeCodeDiscoveredModels);
    expect(after.store.getClaudeCodeDiscoveredModels()).toEqual(options);
  });

  it('survive a change to another Claude Code setting', async () => {
    const options = await detectedOptions();
    const first = await restartApp();
    first.store.setClaudeCodeDiscoveredModels(options);

    // The user turns off project commands and user commands, and sets then clears the upstream URL.
    first.store.setClaudeCodeProjectCommandsEnabled(false);
    first.store.setClaudeCodeUserCommandsEnabled(false);
    first.store.setClaudeCodeApiUpstreamUrl('http://127.0.0.1:8787');
    first.store.setClaudeCodeApiUpstreamUrl('');
    expect(first.store.getClaudeCodeDiscoveredModels()).toEqual(options);

    const second = await restartApp();
    expect(second.store.getClaudeCodeDiscoveredModels()).toEqual(options);
    expect(second.store.getClaudeCodeSettings()).toMatchObject({
      projectCommandsEnabled: false,
      userCommandsEnabled: false,
    });
  });

  it('do not erase the other Claude Code settings when they are saved', async () => {
    const options = await detectedOptions();
    const first = await restartApp();
    first.store.setClaudeCodeProjectCommandsEnabled(false);
    first.store.setClaudeCodeApiUpstreamUrl('http://127.0.0.1:8787');

    first.store.setClaudeCodeDiscoveredModels(options);

    const second = await restartApp();
    expect(second.store.getClaudeCodeSettings()).toMatchObject({
      projectCommandsEnabled: false,
      apiUpstreamUrl: 'http://127.0.0.1:8787',
    });
    expect(second.store.getClaudeCodeDiscoveredModels()).toEqual(options);
  });

  it('show up in the model picker as claude-code:custom rows right after a restart', async () => {
    const options = await detectedOptions();
    const first = await restartApp();
    first.store.setClaudeCodeDiscoveredModels(options);

    const app = await restartApp();
    // Same wiring as the setClaudeModelPickerSource call in main/index.ts. The Claude
    // settings file adds no options of its own here, so only the saved models show.
    app.custom.setClaudeModelPickerSource(async () =>
      app.accountModels.mergePickerWithDiscovered(
        { options: [], replaceBuiltInOptions: false },
        app.store.getClaudeCodeDiscoveredModels(),
      ),
    );

    const rows = await app.custom.withClaudeCustomModels('claude-code', [BUILT_IN_SONNET], undefined);

    expect(rows.map((row) => row.id)).toEqual([MYTHOS_ID, 'claude-code:sonnet']);
    expect(rows[0]).toMatchObject({ name: 'Claude Agent · Claude Mythos 5.2', contextWindow: 1_000_000 });
    // The picker also teaches the app what this model can do (context size, effort, thinking).
    expect(app.custom.behavesAsVariantForModelId(MYTHOS_ID)).toBeDefined();
  });
});

describe('a model the user picked from the detected list after a restart', () => {
  it('is still the default model and is still accepted, even before any model list is loaded', async () => {
    const first = await restartApp();
    first.store.setDefaultAIModel(MYTHOS_ID);

    // Nothing was detected and no picker source is set, so no model list holds this model.
    const app = await restartApp();
    expect(app.store.getClaudeCodeDiscoveredModels()).toEqual([]);
    expect(app.store.getDefaultAIModel()).toBe(MYTHOS_ID);

    const parsed = app.identifier.ModelIdentifier.parse(MYTHOS_ID);
    expect(parsed.isCustomClaudeModel).toBe(true);
    expect(parsed.customClaudeModel).toBe('claude-mythos-5-2');
  });
});
