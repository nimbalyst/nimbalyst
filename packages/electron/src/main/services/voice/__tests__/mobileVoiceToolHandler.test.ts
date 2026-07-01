import { describe, expect, it, vi, beforeEach } from 'vitest';

// RealtimeAPIClient (imported for BUILTIN_VOICE_TOOL_NAMES) pulls in ws/electron/
// analytics at module load; stub them so the handler can be tested in node.
vi.mock('ws', () => ({ default: class {} }));
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }));
vi.mock('../../analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

const getVoiceEnabledExtensionTools = vi.fn();
const getVoiceEnabledBackendToolsForWorkspace = vi.fn();
const resolveBackendWorkspacePath = vi.fn(async (...a: any[]) => a[0] as string);
vi.mock('../../../mcp/mcpWorkspaceResolver', () => ({
  getVoiceEnabledExtensionTools: (...a: any[]) => getVoiceEnabledExtensionTools(...a),
  getVoiceEnabledBackendToolsForWorkspace: (...a: any[]) => getVoiceEnabledBackendToolsForWorkspace(...a),
  resolveBackendWorkspacePath: (...a: any[]) => resolveBackendWorkspacePath(...a),
}));

const handleBackendTool = vi.fn();
const isBackendTool = vi.fn();
vi.mock('../../../mcp/tools/backendToolHandler', () => ({
  handleBackendTool: (...a: any[]) => handleBackendTool(...a),
  isBackendTool: (...a: any[]) => isBackendTool(...a),
}));

const handleExtensionTool = vi.fn();
vi.mock('../../../mcp/tools/extensionToolHandler', () => ({
  handleExtensionTool: (...a: any[]) => handleExtensionTool(...a),
}));

// Mock the shared session search: the real module pulls in the DB/WindowManager
// (and thus electron's `app`) at load. This handler test only needs to verify
// the built-in list_sessions branch routes to it.
const searchSessionsForVoice = vi.fn();
vi.mock('../sessionSearch', () => ({
  searchSessionsForVoice: (...a: any[]) => searchSessionsForVoice(...a),
}));

const getSessionSummaryForVoice = vi.fn();
vi.mock('../sessionSummary', () => ({
  getSessionSummaryForVoice: (...a: any[]) => getSessionSummaryForVoice(...a),
}));

const answerSessionPromptForVoice = vi.fn();
vi.mock('../answerPrompt', () => ({
  answerSessionPromptForVoice: (...a: any[]) => answerSessionPromptForVoice(...a),
}));

import { handleMobileVoiceToolCall } from '../mobileVoiceToolHandler';

const memoryTool = {
  name: 'nimbalyst-memory.search_project_knowledge',
  description: 'Search project knowledge',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  voiceAgent: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  getVoiceEnabledExtensionTools.mockResolvedValue([]);
  getVoiceEnabledBackendToolsForWorkspace.mockResolvedValue([memoryTool]);
  searchSessionsForVoice.mockResolvedValue({ success: true, sessions: [] });
  getSessionSummaryForVoice.mockResolvedValue({ success: true, summary: 'A summary' });
  answerSessionPromptForVoice.mockResolvedValue({ success: true, message: 'Answered.' });
});

describe('handleMobileVoiceToolCall', () => {
  it('runs a voice tool requested by its bare name (mobile is prefix-agnostic)', async () => {
    isBackendTool.mockReturnValue(true);
    handleBackendTool.mockResolvedValue({ content: [{ type: 'text', text: 'Found 3 docs' }], isError: false });

    const out = await handleMobileVoiceToolCall('search_project_knowledge', '{"query":"voice"}', '/ws');

    expect(out.success).toBe(true);
    expect(out.result).toBe('Found 3 docs');
    // Dispatched with the full namespaced name + parsed args.
    expect(handleBackendTool).toHaveBeenCalledWith(
      'nimbalyst-memory.search_project_knowledge',
      'nimbalyst-memory.search_project_knowledge',
      { query: 'voice' },
      '/ws',
    );
  });

  it('runs the built-in list_sessions via the shared semantic search', async () => {
    searchSessionsForVoice.mockResolvedValue({
      success: true,
      sessions: [{ id: 's1', title: 'Voice bugs', status: 'idle', lastActive: 'just now' }],
    });

    const out = await handleMobileVoiceToolCall('list_sessions', '{"query":"voice mode"}', '/ws');

    // Routed to the shared search with the workspace + query (NOT through the
    // extension/backend dispatch, even though list_sessions is a built-in name).
    expect(searchSessionsForVoice).toHaveBeenCalledWith('/ws', 'voice mode');
    expect(handleBackendTool).not.toHaveBeenCalled();
    expect(out.success).toBe(true);
    expect(JSON.parse(out.result!)).toEqual({
      sessions: [{ id: 's1', title: 'Voice bugs', status: 'idle', lastActive: 'just now' }],
    });
  });

  it('runs the built-in get_session_summary via the shared summarizer', async () => {
    getSessionSummaryForVoice.mockResolvedValue({ success: true, summary: 'Session recap text' });

    const out = await handleMobileVoiceToolCall('get_session_summary', '{"session_id":"s1"}', '/ws');

    expect(getSessionSummaryForVoice).toHaveBeenCalledWith('/ws', 's1');
    expect(handleBackendTool).not.toHaveBeenCalled();
    expect(out.success).toBe(true);
    expect(out.result).toBe('Session recap text');
  });

  it('requires a session_id for get_session_summary', async () => {
    const out = await handleMobileVoiceToolCall('get_session_summary', '{}', '/ws');
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/session_id is required/i);
    expect(getSessionSummaryForVoice).not.toHaveBeenCalled();
  });

  it('routes the built-in answer_prompt to the shared answerer', async () => {
    answerSessionPromptForVoice.mockResolvedValue({ success: true, message: 'Answered "Theme" with "Dark".' });

    const out = await handleMobileVoiceToolCall(
      'answer_prompt',
      '{"session_id":"s1","answer":"dark"}',
      '/ws',
    );

    expect(answerSessionPromptForVoice).toHaveBeenCalledWith('/ws', 's1', 'dark');
    expect(handleBackendTool).not.toHaveBeenCalled();
    expect(out.success).toBe(true);
    expect(out.result).toMatch(/Dark/);
  });

  it('requires an answer for answer_prompt', async () => {
    const out = await handleMobileVoiceToolCall('answer_prompt', '{"session_id":"s1"}', '/ws');
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/answer is required/i);
    expect(answerSessionPromptForVoice).not.toHaveBeenCalled();
  });

  it('rejects a tool that is not a registered voice tool (security gate)', async () => {
    const out = await handleMobileVoiceToolCall('rm_rf', '{}', '/ws');

    expect(out.success).toBe(false);
    expect(out.error).toMatch(/not an available voice tool/i);
    expect(handleBackendTool).not.toHaveBeenCalled();
    expect(handleExtensionTool).not.toHaveBeenCalled();
  });

  it('fails gracefully when no workspace is available', async () => {
    const out = await handleMobileVoiceToolCall('search_project_knowledge', '{}', undefined);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/no workspace/i);
  });
});
