import { describe, expect, it, vi } from 'vitest';

// FIX B regression guard: buildNotificationMessage() must bound the reinjected
// `originalPrompt` text (previously unbounded -- unlike the adjacent
// recentMessages content, which is already capped). The cap applies ONLY to
// the notification string; SessionResultData.originalPrompt itself (returned
// by get_session_result and consumed by the UI/session-list) stays untouched.
//
// Mock surface mirrors MetaAgentService.fullResponse.test.ts (enough to import
// MetaAgentService without pulling electron-app / node-pty into the graph).
// buildNotificationMessage takes a plain SessionResultData object directly, so
// no repository mocking is needed beyond making the import succeed.
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

function baseResult(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'child-1',
    title: 'Child: research',
    provider: 'claude-code',
    model: 'claude-code:sonnet',
    status: 'idle',
    lastActivity: 1,
    originalPrompt: null,
    userPrompts: [],
    lastResponse: null,
    fullResponse: null,
    recentMessages: [],
    editedFiles: [],
    pendingPrompt: null,
    errorMessage: null,
    createdAt: 1,
    updatedAt: 2,
    worktreeId: null,
    toolScope: null,
    ...overrides,
  };
}

describe('MetaAgentService.buildNotificationMessage originalPrompt preview (FIX B)', () => {
  it('passes a short prompt through byte-for-byte with the "Original task:" label', () => {
    const service = MetaAgentService.getInstance();
    const shortPrompt = 'Investigate the flaky login test and report root cause.';
    const message = (service as any).buildNotificationMessage(
      'session:completed',
      baseResult({ originalPrompt: shortPrompt }),
    );

    expect(message).toContain(`Original task: ${shortPrompt}`);
    expect(message).not.toContain('Original task preview:');
  });

  it('truncates a long prompt to the fixed cap and labels it "Original task preview:"', () => {
    const service = MetaAgentService.getInstance();
    const longPrompt = 'A'.repeat(3000) + 'MIDDLE' + 'B'.repeat(3000);
    const message = (service as any).buildNotificationMessage(
      'session:completed',
      baseResult({ originalPrompt: longPrompt }),
    );

    const previewLine = message.split('\n').find((line: string) => line.startsWith('Original task preview:'));
    expect(previewLine).toBeDefined();
    // Output never exceeds the fixed cap (2000) plus the label prefix.
    const previewText = previewLine!.slice('Original task preview: '.length);
    expect(previewText.length).toBeLessThanOrEqual(2000);
    // Both head and tail of the original text survive.
    expect(previewText.startsWith('AAAA')).toBe(true);
    expect(previewText.endsWith('BBBB')).toBe(true);
    expect(previewText).not.toContain('MIDDLE');
    expect(previewText).toContain('call get_session_result for the complete prompt');
    expect(message).not.toContain('Original task:');
  });

  it('does not throw on multiline/Unicode input and truncates cleanly near the boundary', () => {
    const service = MetaAgentService.getInstance();
    // Multi-byte emoji (surrogate pairs) padded past the cap, with newlines.
    const longPrompt = '\u{1F600}'.repeat(1500) + '\nsecond line\nthird line';
    expect(() => {
      const message = (service as any).buildNotificationMessage(
        'session:completed',
        baseResult({ originalPrompt: longPrompt }),
      );
      const previewLine = message.split('\n').find((line: string) => line.startsWith('Original task preview:'));
      expect(previewLine).toBeDefined();
      // A lone/split surrogate re-encodes to U+FFFD via TextEncoder/TextDecoder;
      // a correctly-preserved surrogate PAIR (a real emoji) round-trips clean.
      const text = previewLine!.slice('Original task preview: '.length);
      const roundTripped = new TextDecoder('utf-8', { fatal: false }).decode(
        new TextEncoder().encode(text),
      );
      expect(roundTripped).not.toContain('�');
    }).not.toThrow();
  });

  it('keeps get_session_result-equivalent data (SessionResultData.originalPrompt) fully untouched', () => {
    // buildNotificationMessage must not mutate the input result object -- the
    // full originalPrompt remains exactly as constructed for any other reader
    // (get_session_result, UI, session-list) that consumes SessionResultData
    // directly rather than the notification string.
    const service = MetaAgentService.getInstance();
    const longPrompt = 'C'.repeat(5000);
    const result = baseResult({ originalPrompt: longPrompt });

    (service as any).buildNotificationMessage('session:completed', result);

    expect(result.originalPrompt).toBe(longPrompt);
    expect(result.originalPrompt.length).toBe(5000);
  });
});
