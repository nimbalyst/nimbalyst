// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Channel-set gate for the AIService IPC extraction.
 *
 * `setupIpcHandlers()` was a single 2,518-line method registering 52 channels;
 * it is now nine `ipc/register*Handlers.ts` modules. Moving 400-line blocks of
 * handlers between files is exactly the edit where a dropped, renamed, or
 * double-registered channel survives review — the diff is a move, so nothing
 * looks wrong. This runs each registrar against a stub context and asserts the
 * channels it registers, so all three mistakes fail here rather than at a
 * user's keystroke.
 *
 * The 52 below is the set AIService registered before the refactor started.
 */

// vi.mock factories are hoisted above module-level consts, so the collector
// array has to be hoisted with them.
const { registered } = vi.hoisted(() => ({ registered: [] as string[] }));

// Only `safeHandle` is recorded — all 52 AI channels are invoke-style. `safeOn`
// and friends are stubbed because unrelated services (NavigationHistoryService
// via WindowManager) construct singletons at module load and register through
// this module; recording those would pollute the list.
vi.mock('../../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string) => {
    registered.push(channel);
  },
  safeOn: () => {},
  safeOnce: () => {},
  removeHandler: () => {},
  removeAllListeners: () => {},
  isHandlerRegistered: () => false,
}));

// Import-cost trims. Registration only stores closures, so none of these are
// reached; loading them for real costs seconds (the provider tree, node-pty,
// and WindowManager's own module-load singletons).
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  AIProvider: class {},
  GeminiAntigravityProvider: class {},
  OpenAICodexProvider: class {},
  ModelRegistry: {},
  ProviderFactory: {},
  SessionManager: class {},
  isAskUserQuestionProvider: () => false,
}));
vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));
vi.mock('../../../utils/privateSettingsStore', () => ({ default: class {
  store: Record<string, unknown>;
  constructor(options: { defaults?: Record<string, unknown> } = {}) { this.store = options.defaults ?? {}; }
  get(key: string, fallback?: unknown) { return this.store[key] ?? fallback; }
  set(key: string, value: unknown) { this.store[key] = value; }
  onDidChange() { return () => {}; }
  onDidAnyChange() { return () => {}; }
} }));
vi.mock('../../../window/WindowManager', () => ({ getWindowId: () => undefined }));
vi.mock('../../TerminalSessionManager', () => ({ getTerminalSessionManager: () => undefined }));
vi.mock('../../../mcp/tools/backendToolHandler', () => ({ handleBackendTool: () => undefined }));

import { registerInitHandlers } from '../ipc/registerInitHandlers';
import { registerSessionHandlers } from '../ipc/registerSessionHandlers';
import { registerQueuedPromptHandlers } from '../ipc/registerQueuedPromptHandlers';
import { registerInteractivePromptHandlers } from '../ipc/registerInteractivePromptHandlers';
import { registerTurnControlHandlers } from '../ipc/registerTurnControlHandlers';
import { registerSettingsHandlers } from '../ipc/registerSettingsHandlers';
import { registerModelHandlers } from '../ipc/registerModelHandlers';
import { registerProjectSettingsHandlers } from '../ipc/registerProjectSettingsHandlers';
import { registerExtensionChatHandlers } from '../ipc/registerExtensionChatHandlers';
import type { AIServiceContext } from '../ipc/AIServiceContext';

/**
 * A context whose every member throws when called. Registration must only
 * store handler closures, never invoke the service — if a registrar reaches
 * into `ctx` at registration time, that is a behavior change from the inlined
 * version and this fails loudly.
 */
const stubContext = new Proxy({} as AIServiceContext, {
  get: (_target, prop) => () => {
    throw new Error(`ctx.${String(prop)} must not be called during registration`);
  },
});

const EXPECTED_CHANNELS: Record<string, string[]> = {
  registerInitHandlers: [
    'ai:hasApiKey',
    'ai:initialize',
  ],
  registerSessionHandlers: [
    'ai:remoteWorkspaceContext',
    'ai:remoteHosts',
    'ai:createRemoteSession',
    'ai:loadRemoteDraft',
    'ai:saveRemoteDraft',
    'ai:watchRemoteSession',
    'ai:unwatchRemoteSession',
    'ai:queueRemotePrompt',
    'ai:cancelRemoteSession',
    'ai:createSession',
    'ai:sendMessage',
    'ai:getSessions',
    'ai:getSessionList',
    'ai:loadSession',
    'ai:clearSession',
    'ai:updateSessionMessages',
    'ai:updateSessionMetadata',
    'ai:saveDraftInput',
    'ai:cleanupEmptyMessages',
    'ai:deleteSession',
    'ai:advance-diff-baseline',
  ],
  registerQueuedPromptHandlers: [
    'ai:claimQueuedPrompt',
    'ai:completeQueuedPrompt',
    'ai:failQueuedPrompt',
    'ai:listPendingPrompts',
    'ai:createQueuedPrompt',
    'ai:deleteQueuedPrompt',
    'ai:triggerQueueProcessing',
  ],
  registerInteractivePromptHandlers: [
    'ai:exitPlanModeConfirmResponse',
    'claude-code:answer-question',
    'claude-code:cancel-question',
    'claude-code:answer-tool-permission',
    'claude-code:cancel-tool-permission',
  ],
  registerTurnControlHandlers: [
    'ai:cancelRequest',
    'ai:interruptCurrentTurn',
    'ai:compactSession',
  ],
  registerSettingsHandlers: [
    'ai:getHeadlessAgentAvailability',
    'ai:getSettings',
    'ai:saveSettings',
    'ai:testConnection',
  ],
  registerModelHandlers: [
    'ai:getAllModels',
    'ai:clearModelCache',
    'ai:refreshSessionProvider',
    'ai:getAgentWorkflows',
    'ai:getSlashCommands',
    'ai:getModels',
    'mcp:applyDiff:result',
  ],
  registerProjectSettingsHandlers: [
    'ai:getProjectSettings',
    'ai:getProjectTrackerAutomation',
    'ai:saveProjectTrackerAutomation',
    'ai:saveProjectSettings',
    'ai:getEffectiveSettings',
    'ai:clearProjectSettings',
  ],
  registerExtensionChatHandlers: [
    'extensions:ai-send-prompt',
    'extensions:ai-call-backend-tool',
    'extensions:ai-list-models',
    'extensions:ai-chat-completion',
    'extensions:ai-chat-completion-stream-start',
    'extensions:ai-chat-completion-stream-abort',
  ],
};

const REGISTRARS: Record<string, (ctx: AIServiceContext) => void> = {
  registerInitHandlers,
  registerSessionHandlers,
  registerQueuedPromptHandlers,
  registerInteractivePromptHandlers,
  registerTurnControlHandlers,
  registerSettingsHandlers,
  registerModelHandlers,
  registerProjectSettingsHandlers,
  registerExtensionChatHandlers,
};

describe('AIService IPC registrars', () => {
  beforeEach(() => {
    registered.length = 0;
  });

  for (const [name, register] of Object.entries(REGISTRARS)) {
    it(`${name} registers exactly its documented channels`, () => {
      register(stubContext);
      expect(registered).toEqual(EXPECTED_CHANNELS[name]);
    });
  }

  it('registers all 61 channels across the modules, with no duplicates', () => {
    for (const register of Object.values(REGISTRARS)) {
      register(stubContext);
    }
    expect(registered).toHaveLength(61);
    expect(new Set(registered).size).toBe(61);
  });
});
