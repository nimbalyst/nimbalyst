import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron-store', () => ({
  default: class TestStore {
    get(_key: string, fallback?: unknown) { return fallback; }
    set() {}
    delete() {}
  },
}));

vi.mock('../../window/WindowManager', () => ({
  getMostRecentlyFocusedWorkspaceWindow: vi.fn(() => null),
  windowStates: new Map(),
  windowFocusOrder: new Map(),
}));

vi.mock('../../window/windowState', () => ({
  windows: new Map(),
}));

vi.mock('../../services/RepositoryManager', () => ({
  getQueuedPromptsStore: vi.fn(() => {
    throw new Error('production queue store must not be used by the fake route fixture');
  }),
}));

vi.mock('../../utils/logger', () => ({
  logger: new Proxy({}, {
    get: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../utils/store', () => new Proxy({}, {
  get: (_target, property) => property === 'then' ? undefined : vi.fn(),
}));

vi.mock('../../utils/workspaceDetection', () => ({
  resolveProjectPath: (workspacePath: string) => workspacePath,
}));

vi.mock('../settingsServer', () => ({
  settingsToolSchemas: [],
  dispatchSettingsTool: vi.fn(),
}));

vi.mock('../tools/trackerToolHandlers', () => ({
  trackerToolSchemas: [],
  handleTrackerList: vi.fn(),
  handleTrackerGet: vi.fn(),
  handleTrackerListTypes: vi.fn(),
  handleTrackerDefineType: vi.fn(),
  handleTrackerDeleteType: vi.fn(),
  handleTrackerCreate: vi.fn(),
  handleTrackerUpdate: vi.fn(),
  handleTrackerLinkSession: vi.fn(),
  handleTrackerUnlinkSession: vi.fn(),
  handleTrackerLinkFile: vi.fn(),
  handleTrackerAddComment: vi.fn(),
  handleTrackerImporterList: vi.fn(),
  handleTrackerImporterSearch: vi.fn(),
  handleTrackerImport: vi.fn(),
  handleTrackerResnapshot: vi.fn(),
  handleTrackerGetByUrn: vi.fn(),
}));

vi.mock('../mcpWorkspaceResolver', () => ({
  documentStateBySession: new Map(),
  workspaceToWindowMap: new Map(),
  getAvailableExtensionTools: vi.fn(() => []),
  getAvailableBackendTools: vi.fn(() => []),
  resolveBackendWorkspacePath: vi.fn(() => null),
  registerWorkspaceMappingForConnection: vi.fn(),
  registerWorkspaceWindow: vi.fn(),
  unregisterWindow: vi.fn(),
  unregisterExtensionTools: vi.fn(),
  getActiveExtensionShortNames: vi.fn(() => []),
  updateDocumentState: vi.fn(),
  registerExtensionTools: vi.fn(),
}));

vi.mock('../tools/backendToolHandler', () => ({
  handleBackendTool: vi.fn(),
  isBackendTool: vi.fn(() => false),
}));

vi.mock('../backendToolRegistry', () => ({
  setBackendToolsChangeNotifier: vi.fn(),
}));

vi.mock('../tools/voiceToolHandlers', () => ({
  handleVoiceAgentSpeak: vi.fn(),
  handleVoiceAgentStop: vi.fn(),
  voiceToolSchemas: [],
}));

vi.mock('../tools/displayToolHandler', () => ({
  handleDisplayToUser: vi.fn(),
  displayToolSchemas: [],
}));

vi.mock('../tools/editorToolHandlers', () => ({
  handleApplyDiff: vi.fn(),
  handleApplyCollabDocEdit: vi.fn(),
  handleReadCollabDoc: vi.fn(),
  handleStreamContent: vi.fn(),
  handleCaptureEditorScreenshot: vi.fn(),
  handleGetSessionEditedFiles: vi.fn(),
  getEditorToolSchemas: vi.fn(() => []),
}));

vi.mock('../tools/collabIndexToolHandlers', () => ({
  handleCreateSharedDoc: vi.fn(),
  handleCreateSharedFolder: vi.fn(),
  handleMoveSharedItem: vi.fn(),
  handleRenameSharedItem: vi.fn(),
  handleDeleteSharedItem: vi.fn(),
  getCollabIndexToolSchemas: vi.fn(() => []),
}));

vi.mock('../tools/interactiveToolHandlers', () => ({
  handleAskUserQuestion: vi.fn(),
  handleToolPermission: vi.fn(),
  handleGitCommitProposal: vi.fn(),
  handleRequestUserInput: vi.fn(),
  getInteractiveToolSchemas: vi.fn(() => []),
}));

vi.mock('../tools/feedbackToolHandlers', () => ({
  handleFeedbackAnonymizeText: vi.fn(),
  handleFeedbackGetEnvironment: vi.fn(),
  handleFeedbackOpenGithubIssue: vi.fn(),
  feedbackToolSchemas: [],
}));

vi.mock('../tools/extensionToolHandler', () => ({
  handleExtensionTool: vi.fn(),
}));

vi.mock('../sessionContextServer', () => ({
  SESSION_CONTEXT_TOOL_SCHEMAS: [],
  dispatchSessionContextTool: vi.fn(),
}));

vi.mock('../sessionNamingServer', () => ({
  buildSessionMetaToolSchemas: vi.fn(() => []),
  dispatchSessionMetaTool: vi.fn(),
}));
import {
  shutdownHttpServer,
  startMcpHttpServer,
} from '../httpServer';
import { setMcpAuthTokenForTest } from '../mcpAuth';
import {
  META_AGENT_TOOL_DEFS,
  getMetaAgentOpenAITools,
} from '../metaAgentServer';
import type { HostControlDependencies } from '../../services/HostControlService';
import type { PriorityPromptDeliveryResult } from '../../services/PriorityPromptDeliveryService';

const token = 'stage-7-test-token';
const verifiedResult: PriorityPromptDeliveryResult = {
  controlRowId: 'row-1',
  routingWorkspacePath: 'D:/fake-workspace',
  action: 'idle_dispatch_triggered',
  processingTriggerCalled: true,
  processingTriggerAccepted: true,
  interrupt: null,
  verification: {
    row: {
      id: 'row-1',
      status: 'executing',
      deliveryClass: 'control',
      priorityRank: 0,
      interruptTargetGeneration: null,
      hasInterruptReceipt: false,
    },
    sessionStatus: 'running',
    deliveryObserved: true,
  },
};

const request = {
  version: 1,
  operation: 'watcher_obligation_event',
  sessionId: 'session-1',
  prompt: 'priority prompt',
  obligationId: 'obligation-1',
  eventKey: 'liveness_breach',
};

describe('POST /host-control', () => {
  let port: number;
  let deps: HostControlDependencies;

  beforeEach(async () => {
    setMcpAuthTokenForTest(token);
    deps = {
      getSession: vi.fn(async (sessionId: string) => ({
        id: sessionId,
        workspacePath: 'D:/fake-workspace',
      })),
      deliverPriorityPrompt: vi.fn(async () => verifiedResult),
    };
    ({ port } = await startMcpHttpServer(0, { hostControlDependencies: deps }));
  });

  afterEach(async () => {
    await shutdownHttpServer();
    setMcpAuthTokenForTest(null);
  });

  function post(body: string, bearer = token): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/host-control`, {
      method: 'POST',
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        'Content-Type': 'application/json',
      },
      body,
    });
  }

  it('rejects missing and incorrect bearer tokens', async () => {
    const missing = await post(JSON.stringify(request), '');
    const incorrect = await post(JSON.stringify(request), 'wrong-token');

    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe('Unauthorized');
    expect(incorrect.status).toBe(401);
    expect(await incorrect.text()).toBe('Unauthorized');
  });

  it('does not expose the route through GET or DELETE', async () => {
    const headers = { Authorization: `Bearer ${token}` };
    const getResponse = await fetch(`http://127.0.0.1:${port}/host-control`, { headers });
    const deleteResponse = await fetch(`http://127.0.0.1:${port}/host-control`, {
      method: 'DELETE',
      headers,
    });

    expect(getResponse.status).toBe(404);
    expect(deleteResponse.status).toBe(404);
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.deliverPriorityPrompt).not.toHaveBeenCalled();
  });

  it('returns a bounded 400 receipt for malformed JSON', async () => {
    const response = await post('{not-json');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      accepted: false,
      outcome: 'malformed_json',
    });
  });

  it('stops at the 4096-byte cap and returns a bounded 413 receipt', async () => {
    const response = await post(JSON.stringify({ padding: 'x'.repeat(5000) }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      accepted: false,
      outcome: 'request_too_large',
    });
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.deliverPriorityPrompt).not.toHaveBeenCalled();
  });

  it('delivers a valid watcher event through the fake loopback fixture', async () => {
    const response = await post(JSON.stringify(request));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: true,
      outcome: 'priority_delivery_verified',
    });
    expect(deps.deliverPriorityPrompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      workspacePath: 'D:/fake-workspace',
      idempotencyKey: 'watcher-obligation:obligation-1:liveness_breach',
    }));
  });

  it('returns the bounded Stage 9 placeholder rejection', async () => {
    const response = await post(JSON.stringify({
      version: 1,
      operation: 'inject_attention_reply',
    }));

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      accepted: false,
      outcome: 'not_yet_available',
    });
    expect(deps.deliverPriorityPrompt).not.toHaveBeenCalled();
  });

  it('is absent from built-in and extension ListTools surfaces', () => {
    const serializedBuiltIn = JSON.stringify(META_AGENT_TOOL_DEFS);
    const serializedExtension = JSON.stringify(getMetaAgentOpenAITools());

    expect(serializedBuiltIn).not.toContain('host-control');
    expect(serializedBuiltIn).not.toContain('watcher_obligation_event');
    expect(serializedExtension).not.toContain('host-control');
    expect(serializedExtension).not.toContain('watcher_obligation_event');
  });
});
