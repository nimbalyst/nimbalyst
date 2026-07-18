import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn(), isDestroyed: () => false },
  };
  return {
    handlers,
    fakeWindow,
    windows: new Map<number, any>(),
    windowStates: new Map<number, any>(),
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    updateMetadata: vi.fn().mockResolvedValue(undefined),
    dialogShowMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
    destroyProvider: vi.fn(),
  };
});

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: any[]) => Promise<any>) => {
    mocks.handlers.set(channel, handler);
  },
  safeOn: vi.fn(),
}));

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  SessionManager: class {
    initialize = vi.fn().mockResolvedValue(undefined);
  },
  ProviderFactory: { destroyProvider: mocks.destroyProvider },
}));

vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: {
    create: mocks.create,
    get: mocks.get,
    updateMetadata: mocks.updateMetadata,
  },
  TranscriptMigrationRepository: { hasService: () => false },
}));

vi.mock('@nimbalyst/runtime/ai/server/transcript', () => ({
  TranscriptProjector: class {},
}));

vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: {
    getInstance: () => ({ sendEvent: vi.fn() }),
  },
}));

vi.mock('../../tray/TrayManager', () => ({
  TrayManager: { getInstance: () => ({ onPromptResolved: vi.fn() }) },
}));

vi.mock('../../services/TranscriptToolCallEnricher', () => ({
  enrichTranscriptMessagesWithToolCallDiffs: vi.fn(),
}));

vi.mock('../../services/ai/pendingPromptPersistence', () => ({
  capturePendingPromptActionOwnership: vi.fn(),
  promptActionOwnsCurrentGeneration: vi.fn(),
  setSessionPendingPrompt: vi.fn(),
}));

vi.mock('../../services/ai/orphanedPromptTurnSettlement', () => ({
  settleOrphanedPromptTurn: vi.fn(),
}));

vi.mock('../../services/AttentionEventService', () => ({
  attentionEventService: { cancelInteractivePrompt: vi.fn() },
}));

vi.mock('../../window/windowState', () => ({
  windows: mocks.windows,
  windowStates: mocks.windowStates,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: () => mocks.fakeWindow,
    getAllWindows: () => [mocks.fakeWindow],
  },
  dialog: { showMessageBox: mocks.dialogShowMessageBox },
  ipcMain: { listenerCount: () => 0, emit: vi.fn() },
}));

import { ATTENTION_SUPERVISOR_METADATA_KEY } from '../../services/AttentionSupervisorAuthorization';
import { registerSessionHandlers } from '../SessionHandlers';

function event() {
  return { sender: { send: vi.fn() } } as any;
}

async function invoke(channel: string, ...args: any[]) {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler(event(), ...args);
}

describe('SessionHandlers reserved attention-supervisor metadata routes', () => {
  beforeAll(async () => {
    await registerSessionHandlers();
  });

  beforeEach(() => {
    mocks.create.mockClear();
    mocks.get.mockReset().mockResolvedValue({
      id: 'session-1',
      provider: 'claude-code',
      workspacePath: '/workspace',
      messages: [],
      metadata: {},
    });
    mocks.updateMetadata.mockClear();
    mocks.fakeWindow.webContents.send.mockClear();
    mocks.destroyProvider.mockClear();
    mocks.dialogShowMessageBox.mockClear();
  });

  it.each([
    { [ATTENTION_SUPERVISOR_METADATA_KEY]: ['attacker'] },
    { metadata: { [ATTENTION_SUPERVISOR_METADATA_KEY]: [] } },
  ])('rejects sessions:create reserved-key seeding before create/write', async (attempt) => {
    const result = await invoke('sessions:create', {
      workspaceId: '/workspace',
      session: {
        id: 'new-session',
        provider: 'claude-code',
        model: 'claude-code:sonnet',
        ...attempt,
      },
    });

    expect(result).toMatchObject({ success: false });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });

  it.each([
    ['sessions:update-metadata', { [ATTENTION_SUPERVISOR_METADATA_KEY]: null }],
    ['sessions:update-metadata', { metadata: { [ATTENTION_SUPERVISOR_METADATA_KEY]: [] } }],
    ['sessions:update-session-metadata', { [ATTENTION_SUPERVISOR_METADATA_KEY]: undefined }],
    ['sessions:update-session-metadata', { metadata: { [ATTENTION_SUPERVISOR_METADATA_KEY]: ['attacker'] } }],
  ])('rejects %s before repository write and renderer broadcast', async (channel, attempt) => {
    const result = await invoke(channel, 'session-1', attempt);

    expect(result).toMatchObject({ success: false });
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
    expect(mocks.fakeWindow.webContents.send).not.toHaveBeenCalled();
  });

  it('keeps ordinary metadata updates working on both generic update routes', async () => {
    await expect(invoke('sessions:update-metadata', 'session-1', {
      metadata: { tags: ['nim-362'] },
    })).resolves.toMatchObject({ success: true });
    await expect(invoke('sessions:update-session-metadata', 'session-1', {
      phase: 'validating',
    })).resolves.toMatchObject({ success: true });

    expect(mocks.updateMetadata).toHaveBeenCalledTimes(2);
  });

  it.each([
    { authorized: true, existing: [], expected: ['supervisor-session'] },
    { authorized: false, existing: ['supervisor-session'], expected: [] },
  ])('leaves the confirmed, workspace-bound dedicated route able to grant/revoke ($authorized)', async ({
    authorized,
    existing,
    expected,
  }) => {
    mocks.windows.set(7, mocks.fakeWindow);
    mocks.windowStates.set(7, {
      mode: 'workspace',
      workspacePath: '/workspace',
      activeWorkspacePath: '/workspace',
    });
    mocks.get.mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      provider: 'claude-code',
      workspacePath: '/workspace',
      messages: [],
      metadata: sessionId === 'target-session'
        ? { [ATTENTION_SUPERVISOR_METADATA_KEY]: existing }
        : {},
    }));

    const result = await invoke('sessions:set-attention-supervisor-authorization', {
      workspacePath: '/workspace',
      targetSessionId: 'target-session',
      supervisorSessionId: 'supervisor-session',
      authorized,
    });

    expect(result).toMatchObject({ success: true, authorized });
    expect(mocks.dialogShowMessageBox).toHaveBeenCalledTimes(1);
    expect(mocks.updateMetadata).toHaveBeenCalledWith('target-session', {
      metadata: { [ATTENTION_SUPERVISOR_METADATA_KEY]: expected },
    });
  });
});
