import { describe, expect, it, vi } from 'vitest';

// NIM-427: buildNotificationMessage() echoed result.originalPrompt into the
// child-session completion notification with no length cap -- a long parent
// task prompt would echo in full. Guards the 500-char + ellipsis truncation,
// mirrored from extractLastAgentResponse's existing preview-cap convention
// used one line above for the sibling "Last response" field.
//
// Mock surface mirrors MetaAgentService.fullResponse.test.ts (enough to
// import MetaAgentService without pulling electron-app / node-pty into the
// graph). buildNotificationMessage is synchronous and pure over its
// SessionResultData argument, so no repository mocks need real behavior.
vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: { create: vi.fn(), updateMetadata: vi.fn(), get: vi.fn() },
  AgentMessagesRepository: { list: vi.fn() },
  SessionFilesRepository: { getFilesBySession: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ClaudeCodeProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexProvider: { setMetaAgentServerPort: vi.fn() },
  OpenAICodexACPProvider: { setMetaAgentServerPort: vi.fn() },
  SessionManager: class { async initialize() {} },
}));
vi.mock('@nimbalyst/runtime/ai/server/types', () => ({
  ModelIdentifier: {
    parse: (id: string) => ({ provider: id.split(':')[0], model: id.split(':')[1], combined: id }),
    tryParse: (id: string) => {
      const i = typeof id === 'string' ? id.indexOf(':') : -1;
      return i > 0 ? { provider: id.slice(0, i), model: id.slice(i + 1) } : null;
    },
    getDefaultModelId: (provider: string) => `${provider}:default`,
  },
}));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: () => ({ subscribe: vi.fn() }),
}));
vi.mock('../ai/providerResolution', () => ({
  resolveExtensionAgentRef: () => null,
  isExtensionAgentProvider: () => false,
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../SyncManager', () => ({ getSyncProvider: () => ({ pushChange: vi.fn() }) }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/store', () => ({ getDefaultAIModel: () => null }));
vi.mock('../../utils/timestampUtils', () => ({ toMillis: (v: unknown) => v }));
vi.mock('../WorktreeStore', () => ({ createWorktreeStore: vi.fn() }));
vi.mock('../GitWorktreeService', () => ({ GitWorktreeService: class {} }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: {} }));
vi.mock('./ai/AIService', () => ({ AIService: class {} }));
vi.mock('../../mcp/metaAgentServer', () => ({
  setMetaAgentToolFns: vi.fn(),
}));
vi.mock('../metaAgentNotificationSignature', () => ({ computeNotificationSignature: vi.fn() }));
vi.mock('../metaAgentMessageText', () => ({
  extractMessageText: (content: unknown) => (typeof content === 'string' ? content : ''),
  extractUserPrompts: () => ['original task'],
}));
vi.mock('../ai/claudeCliLauncherSingleton', () => ({
  ClaudeCliLauncherConfig: { setMetaAgentServerPort: vi.fn() },
}));

import { MetaAgentService } from '../MetaAgentService';

const BASE_RESULT = {
  sessionId: 'child-1',
  title: 'Child task',
  status: 'idle',
  originalPrompt: null as string | null,
  recentMessages: [] as Array<{ direction: string; text: string }>,
  editedFiles: [] as string[],
  toolScope: null,
  errorMessage: null,
  lastResponse: null,
};

describe('MetaAgentService.buildNotificationMessage originalPrompt cap (NIM-427)', () => {
  it('truncates a long originalPrompt to 500 chars with an ellipsis', () => {
    const service = MetaAgentService.getInstance();
    const longPrompt = 'P'.repeat(2000);
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: longPrompt,
    });

    const line = message.split('\n').find((l: string) => l.startsWith('Original task: '));
    expect(line).toBeDefined();
    const echoed = line!.slice('Original task: '.length);
    expect(echoed.length).toBe(503); // 500 + '...'
    expect(echoed.endsWith('...')).toBe(true);
    expect(echoed.startsWith('P'.repeat(500))).toBe(true);
  });

  it('does not truncate or alter a prompt already under the cap', () => {
    const service = MetaAgentService.getInstance();
    const shortPrompt = 'Fix the login bug';
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: shortPrompt,
    });

    expect(message).toContain(`Original task: ${shortPrompt}`);
    expect(message).not.toContain('...');
  });

  it('omits the Original task line entirely when there is no prompt', () => {
    const service = MetaAgentService.getInstance();
    const message = (service as any).buildNotificationMessage('session:completed', {
      ...BASE_RESULT,
      originalPrompt: null,
    });

    expect(message).not.toContain('Original task:');
  });
});
