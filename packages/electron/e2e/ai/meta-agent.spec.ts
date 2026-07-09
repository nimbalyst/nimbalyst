import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  createTempWorkspace,
  launchElectronApp,
  waitForAppReady,
} from '../helpers';
import {
  dismissAPIKeyDialog,
  PLAYWRIGHT_TEST_SELECTORS,
  switchToAgentMode,
} from '../utils/testHelpers';
import {
  insertAssistantText,
  insertMessage,
  insertUserPrompt,
} from '../utils/interactivePromptTestHelpers';

test.describe.configure({ mode: 'serial' });

type SessionListResponse = {
  success: boolean;
  sessions: Array<{
    id: string;
    title: string;
    agentRole?: 'standard' | 'meta-agent';
    createdBySessionId?: string | null;
  }>;
};

type MetaAgentMcpClient = {
  client: Client;
  transport: StreamableHTTPClientTransport;
};

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;
let metaSessionId: string;
let metaAgentClient: MetaAgentMcpClient;
const registeredFallbackChannels = new Set<string>();

async function invokeElectron<T>(page: Page, channel: string, ...args: unknown[]): Promise<T> {
  return await page.evaluate(
    async ({ invokeChannel, invokeArgs }) => {
      return await (window as any).electronAPI.invoke(invokeChannel, ...invokeArgs);
    },
    { invokeChannel: channel, invokeArgs: args }
  );
}

async function createMetaAgentSession(page: Page, workspaceId: string): Promise<string> {
  const sessionId = crypto.randomUUID();
  const result = await invokeElectron<{ success: boolean; id?: string }>(page, 'sessions:create', {
    session: {
      id: sessionId,
      provider: 'claude-code',
      model: null,
      title: 'Meta Agent',
      agentRole: 'meta-agent',
    },
    workspaceId,
  });
  if (!result?.success || !result.id) {
    throw new Error('Failed to create meta-agent session');
  }
  return result.id;
}

async function getMetaSessionId(page: Page, workspaceId: string): Promise<string> {
  await expect
    .poll(async () => {
      const result = await invokeElectron<SessionListResponse>(page, 'sessions:list', workspaceId, {
        includeArchived: false,
      });

      if (!result?.success) {
        return null;
      }

      const metaSession = result.sessions.find((session) => session.agentRole === 'meta-agent');
      return metaSession?.id ?? null;
    })
    .not.toBeNull();

  const result = await invokeElectron<SessionListResponse>(page, 'sessions:list', workspaceId, {
    includeArchived: false,
  });
  const metaSession = result.sessions.find((session) => session.agentRole === 'meta-agent');
  if (!metaSession) {
    throw new Error('Meta-agent session was not created');
  }
  return metaSession.id;
}

async function getMetaAgentServerPort(page: Page): Promise<number> {
  const result = await invokeElectron<{ success: boolean; port: number | null }>(
    page,
    'meta-agent:get-server-port'
  );
  if (!result.success || !result.port) {
    throw new Error(`Meta-agent MCP server port unavailable: ${JSON.stringify(result)}`);
  }
  return result.port;
}

async function getMcpAuthToken(page: Page): Promise<string> {
  const result = await invokeElectron<{ success: boolean; token: string | null }>(
    page,
    'mcp:get-auth-token'
  );
  if (!result.success || !result.token) {
    throw new Error(`MCP auth token unavailable: ${JSON.stringify(result)}`);
  }
  return result.token;
}

async function initializeMetaAgentMcp(port: number, sessionId: string, workspaceId: string, authToken: string): Promise<MetaAgentMcpClient> {
  // Issue #146: the meta-agent server now requires a bearer token. Forward
  // it on every request via requestInit.headers, which streamableHttp.ts
  // merges into both the POST and the GET (SSE) calls.
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp?sessionId=${encodeURIComponent(sessionId)}&workspaceId=${encodeURIComponent(workspaceId)}`),
    {
      requestInit: {
        headers: { Authorization: `Bearer ${authToken}` },
      },
    }
  );
  const client = new Client(
    {
      name: 'playwright-meta-agent',
      version: '1.0.0',
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);
  return { client, transport };
}

async function reconnectMetaAgentClient(sessionId: string): Promise<void> {
  if (metaAgentClient) {
    await metaAgentClient.transport.terminateSession().catch(() => undefined);
    await metaAgentClient.client.close().catch(() => undefined);
  }

  const port = await getMetaAgentServerPort(page);
  const token = await getMcpAuthToken(page);
  metaAgentClient = await initializeMetaAgentMcp(port, sessionId, workspacePath, token);
}

async function listMcpTools(client: MetaAgentMcpClient): Promise<string[]> {
  const result = await client.client.listTools();
  return Array.isArray(result.tools) ? result.tools.map((tool) => tool.name) : [];
}

async function callMetaAgentTool<T>(
  client: MetaAgentMcpClient,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const result = await client.client.callTool({
    name,
    arguments: args,
  });
  const toolText = result.content?.find?.((entry: { type: string }) => entry.type === 'text')?.text;
  if (result.isError) {
    throw new Error(
      `Meta-agent tool ${name} failed: ${typeof toolText === 'string' ? toolText : JSON.stringify(result)}`
    );
  }
  if (typeof toolText !== 'string') {
    throw new Error(`Tool ${name} did not return text content: ${JSON.stringify(result)}`);
  }

  return JSON.parse(toolText) as T;
}

type CreateSessionToolResult = {
  sessionId: string;
  title: string;
  worktreeId?: string | null;
  worktreePath?: string | null;
  worktreeMode?: 'new' | 'existing' | 'none';
};

type WorktreeSummary = {
  id: string;
  name: string;
  displayName: string | null;
  path: string;
  branch: string;
  baseBranch: string;
  sessionCount: number;
  createdAt: number;
  updatedAt: number | null;
};

async function createChildSessionWithMetaAgent(
  prompt: string,
  overrides: Partial<{
    title: string;
    useWorktree: boolean;
    worktreeId: string;
  }> = {}
): Promise<CreateSessionToolResult> {
  return await callMetaAgentTool<CreateSessionToolResult>(metaAgentClient, 'create_session', {
    title: overrides.title ?? 'Delegated parser task',
    prompt,
    useWorktree: overrides.useWorktree ?? false,
    ...(overrides.worktreeId ? { worktreeId: overrides.worktreeId } : {}),
  });
}

async function createLinkedTestSession(options: {
  title: string;
  status?: 'idle' | 'running' | 'waiting_for_input' | 'error' | 'interrupted';
  createdAt?: number;
  updatedAt?: number;
  lastActivity?: number;
}): Promise<string> {
  const sessionId = `meta-agent-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await invokeElectron<{ success: boolean; id?: string; error?: string }>(
    page,
    'test:insert-session',
    {
      id: sessionId,
      workspaceId: workspacePath,
      title: options.title,
      provider: 'claude-code',
      model: 'claude-code:opus',
      createdBySessionId: metaSessionId,
      status: options.status ?? 'idle',
      createdAt: options.createdAt,
      updatedAt: options.updatedAt,
      lastActivity: options.lastActivity,
    }
  );

  if (!result.success) {
    throw new Error(`Failed to create linked test session: ${result.error}`);
  }

  return sessionId;
}

async function registerAskUserQuestionFallback(sessionId: string): Promise<void> {
  const channel = `ask-user-question:${sessionId}`;
  if (registeredFallbackChannels.has(channel)) {
    return;
  }

  await electronApp.evaluate(({ ipcMain }, fallbackChannel) => {
    const globalStore = globalThis as any;
    globalStore.__metaAgentAskUserFallbacks ||= {};

    const existing = globalStore.__metaAgentAskUserFallbacks[fallbackChannel];
    if (existing) {
      ipcMain.removeListener(fallbackChannel, existing);
    }

    const handler = () => {};
    globalStore.__metaAgentAskUserFallbacks[fallbackChannel] = handler;
    ipcMain.on(fallbackChannel, handler);
  }, channel);

  registeredFallbackChannels.add(channel);
}

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();

  await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'README.md'), '# Meta Agent Test Workspace\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'src', 'parser.ts'), 'export const parse = () => "ok";\n', 'utf8');
  execSync('git init', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git add .', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: workspacePath, stdio: 'pipe' });

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    permissionMode: 'allow-all',
  });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await dismissAPIKeyDialog(page);

  // Switch to agent mode and create the meta-agent session via IPC
  await switchToAgentMode(page);
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode)).toBeVisible();

  metaSessionId = await createMetaAgentSession(page, workspacePath);
  const port = await getMetaAgentServerPort(page);
  const token = await getMcpAuthToken(page);
  metaAgentClient = await initializeMetaAgentMcp(port, metaSessionId, workspacePath, token);
});

test.afterAll(async () => {
  if (metaAgentClient) {
    await metaAgentClient.transport.terminateSession().catch(() => undefined);
    await metaAgentClient.client.close().catch(() => undefined);
  }

  if (registeredFallbackChannels.size > 0) {
    await electronApp.evaluate(({ ipcMain }, channels) => {
      const globalStore = globalThis as any;
      const handlers = globalStore.__metaAgentAskUserFallbacks || {};
      for (const channel of channels) {
        const handler = handlers[channel];
        if (handler) {
          ipcMain.removeListener(channel, handler);
          delete handlers[channel];
        }
      }
    }, Array.from(registeredFallbackChannels));
  }

  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

test('creates a meta-agent session that appears in the session list as a group', async () => {
  const sessions = await invokeElectron<SessionListResponse>(page, 'sessions:list', workspacePath, {
    includeArchived: false,
  });
  const metaSessions = sessions.sessions.filter((session) => session.agentRole === 'meta-agent');
  expect(metaSessions).toHaveLength(1);
  expect(metaSessions[0].id).toBe(metaSessionId);

  // Meta-agent sessions should appear as a MetaAgentGroup in the session list
  await expect(page.locator('[data-testid="meta-agent-group"]')).toBeVisible();
});

test('surfaces delegated child sessions through the meta-agent MCP tools', async () => {
  const toolNames = await listMcpTools(metaAgentClient);
  expect(toolNames.length).toBeGreaterThan(0);
  expect(toolNames).toContain('list_queued_prompts');

  const created = await createChildSessionWithMetaAgent('Investigate parser edge cases');
  await insertUserPrompt(page, created.sessionId, 'Investigate parser edge cases');
  await insertAssistantText(page, created.sessionId, 'Parser fix is ready for review.');

  const fileLinkResult = await invokeElectron<{ success: boolean; error?: string }>(
    page,
    'session-files:add-link',
    created.sessionId,
    workspacePath,
    path.join(workspacePath, 'src', 'parser.ts'),
    'edited',
    { source: 'playwright-meta-agent' }
  );
  expect(fileLinkResult.success, fileLinkResult.error).toBe(true);

  const spawnedSessions = await callMetaAgentTool<Array<{ sessionId: string; title: string }>>(
    metaAgentClient,
    'list_spawned_sessions',
    {}
  );
  expect(spawnedSessions.some((session) => session.sessionId === created.sessionId)).toBe(true);

  const status = await callMetaAgentTool<{ sessionId: string; status: string; createdBySessionId: string | null }>(
    metaAgentClient,
    'get_session_status',
    { sessionId: created.sessionId }
  );
  expect(status.sessionId).toBe(created.sessionId);
  expect(status.status).toBe('idle');
  expect(status.createdBySessionId).toBe(metaSessionId);

  const result = await callMetaAgentTool<{
    sessionId: string;
    originalPrompt: string | null;
    lastResponse: string | null;
    editedFiles: string[];
  }>(metaAgentClient, 'get_session_result', { sessionId: created.sessionId });
  expect(result.sessionId).toBe(created.sessionId);
  expect(result.originalPrompt).toBe('Investigate parser edge cases');
  expect(result.lastResponse).toContain('Parser fix is ready for review.');
  expect(result.editedFiles).toContain('src/parser.ts');
});

test('respond_to_prompt resolves child AskUserQuestion prompts when a real waiter exists', async () => {
  const waitingSessionId = await createLinkedTestSession({
    title: 'Delegated release question',
    status: 'waiting_for_input',
  });
  await registerAskUserQuestionFallback(waitingSessionId);

  const questionId = `question-${Date.now()}`;
  await insertMessage(
    page,
    waitingSessionId,
    'output',
    JSON.stringify({
      type: 'ask_user_question_request',
      questionId,
      questions: [
        {
          question: 'Which release should ship first?',
          header: 'Release Order',
          options: [
            { label: 'API', description: 'Ship the API changes first' },
            { label: 'UI', description: 'Ship the UI changes first' },
          ],
          multiSelect: false,
        },
      ],
      timestamp: Date.now(),
      status: 'pending',
    }),
    { source: 'claude-code' }
  );

  const pendingResult = await callMetaAgentTool<{
    sessionId: string;
    pendingPrompt: { promptId: string; promptType: string } | null;
  }>(metaAgentClient, 'get_session_result', { sessionId: waitingSessionId });
  expect(pendingResult.sessionId).toBe(waitingSessionId);
  expect(pendingResult.pendingPrompt).toMatchObject({
    promptId: questionId,
    promptType: 'ask_user_question_request',
  });

  const response = await callMetaAgentTool<{ success: boolean; promptId: string }>(
    metaAgentClient,
    'respond_to_prompt',
    {
      sessionId: waitingSessionId,
      promptId: questionId,
      promptType: 'ask_user_question_request',
      response: {
        answers: {
          'Which release should ship first?': 'API',
        },
      },
    }
  );
  expect(response.success).toBe(true);
  expect(response.promptId).toBe(questionId);

  const resolvedResult = await callMetaAgentTool<{
    pendingPrompt: null | { promptId: string; promptType: string };
  }>(metaAgentClient, 'get_session_result', { sessionId: waitingSessionId });
  expect(resolvedResult.pendingPrompt).toBeNull();

  const pendingPrompts = await invokeElectron<{ success: boolean; prompts: unknown[] }>(
    page,
    'messages:get-pending-prompts',
    waitingSessionId
  );
  expect(pendingPrompts.success).toBe(true);
  expect(pendingPrompts.prompts).toHaveLength(0);
});

test('creates worktree-backed child sessions and can attach new child sessions to an existing worktree', async () => {
  const worktreeChild = await createChildSessionWithMetaAgent('Implement parser worktree flow', {
    title: 'Worktree parser task',
    useWorktree: true,
  });
  expect(worktreeChild.worktreeMode).toBe('new');
  expect(worktreeChild.worktreeId).toBeTruthy();
  expect(worktreeChild.worktreePath).toBeTruthy();
  expect(worktreeChild.worktreePath).not.toBe(workspacePath);

  await expect
    .poll(async () => {
      if (!worktreeChild.worktreePath) return false;
      return await fs
        .stat(worktreeChild.worktreePath)
        .then(() => true)
        .catch(() => false);
    })
    .toBe(true);

  const listedWorktrees = await callMetaAgentTool<WorktreeSummary[]>(
    metaAgentClient,
    'list_worktrees',
    {}
  );
  const createdWorktree = listedWorktrees.find((worktree) => worktree.id === worktreeChild.worktreeId);
  expect(createdWorktree).toBeTruthy();
  expect(createdWorktree?.path).toBe(worktreeChild.worktreePath);
  expect(createdWorktree?.branch).toContain('worktree/');
  expect(createdWorktree?.sessionCount).toBeGreaterThanOrEqual(1);

  const attachedChild = await createChildSessionWithMetaAgent('Continue parser work in existing worktree', {
    title: 'Existing worktree follow-up',
    worktreeId: worktreeChild.worktreeId!,
  });
  expect(attachedChild.worktreeMode).toBe('existing');
  expect(attachedChild.worktreeId).toBe(worktreeChild.worktreeId);
  expect(attachedChild.worktreePath).toBe(worktreeChild.worktreePath);

  const spawnedSessions = await callMetaAgentTool<Array<{ sessionId: string; worktreeId: string | null }>>(
    metaAgentClient,
    'list_spawned_sessions',
    {}
  );
  const matchingSessions = spawnedSessions.filter(
    (session) => session.worktreeId === worktreeChild.worktreeId
  );
  expect(matchingSessions.map((session) => session.sessionId)).toEqual(
    expect.arrayContaining([worktreeChild.sessionId, attachedChild.sessionId])
  );

  const afterAttachWorktrees = await callMetaAgentTool<WorktreeSummary[]>(
    metaAgentClient,
    'list_worktrees',
    {}
  );
  const updatedWorktree = afterAttachWorktrees.find((worktree) => worktree.id === worktreeChild.worktreeId);
  expect(updatedWorktree?.sessionCount).toBeGreaterThanOrEqual(2);
});

// =========================================================================
// Stuck-state resilience tests
// =========================================================================

test('respond_to_prompt resolves child permission_request prompts', async () => {
  const waitingSessionId = await createLinkedTestSession({
    title: 'Delegated permission test',
    status: 'waiting_for_input',
  });

  const requestId = `perm-${Date.now()}`;
  await insertMessage(
    page,
    waitingSessionId,
    'output',
    JSON.stringify({
      type: 'permission_request',
      requestId,
      toolName: 'Bash',
      rawCommand: 'rm -rf /tmp/test',
      pattern: 'rm *',
      isDestructive: true,
      timestamp: Date.now(),
      status: 'pending',
    }),
    { source: 'claude-code' }
  );

  const pendingResult = await callMetaAgentTool<{
    sessionId: string;
    pendingPrompt: { promptId: string; promptType: string } | null;
  }>(metaAgentClient, 'get_session_result', { sessionId: waitingSessionId });
  expect(pendingResult.pendingPrompt).toMatchObject({
    promptId: requestId,
    promptType: 'permission_request',
  });

  const response = await callMetaAgentTool<{ success: boolean; promptId: string }>(
    metaAgentClient,
    'respond_to_prompt',
    {
      sessionId: waitingSessionId,
      promptId: requestId,
      promptType: 'permission_request',
      response: { decision: 'allow', scope: 'once' },
    }
  );
  expect(response.success).toBe(true);
  expect(response.promptId).toBe(requestId);

  const resolvedResult = await callMetaAgentTool<{
    pendingPrompt: null | { promptId: string };
  }>(metaAgentClient, 'get_session_result', { sessionId: waitingSessionId });
  expect(resolvedResult.pendingPrompt).toBeNull();
});

test('respond_to_prompt resolves child exit_plan_mode_request prompts', async () => {
  const waitingSessionId = await createLinkedTestSession({
    title: 'Delegated plan review',
    status: 'waiting_for_input',
  });

  const requestId = `plan-${Date.now()}`;
  await insertMessage(
    page,
    waitingSessionId,
    'output',
    JSON.stringify({
      type: 'exit_plan_mode_request',
      requestId,
      planFilePath: '/tmp/test-plan.md',
      allowedPrompts: [],
      timestamp: Date.now(),
      status: 'pending',
    }),
    { source: 'claude-code' }
  );

  const pendingResult = await callMetaAgentTool<{
    pendingPrompt: { promptId: string; promptType: string } | null;
  }>(metaAgentClient, 'get_session_result', { sessionId: waitingSessionId });
  expect(pendingResult.pendingPrompt).toMatchObject({
    promptId: requestId,
    promptType: 'exit_plan_mode_request',
  });

  const response = await callMetaAgentTool<{ success: boolean }>(
    metaAgentClient,
    'respond_to_prompt',
    {
      sessionId: waitingSessionId,
      promptId: requestId,
      promptType: 'exit_plan_mode_request',
      response: { approved: true, clearContext: false },
    }
  );
  expect(response.success).toBe(true);

  const resolvedResult = await callMetaAgentTool<{
    pendingPrompt: null | { promptId: string };
  }>(metaAgentClient, 'get_session_result', { sessionId: waitingSessionId });
  expect(resolvedResult.pendingPrompt).toBeNull();
});

test('send_prompt queues a follow-up message to a child session', async () => {
  const childSessionId = await createLinkedTestSession({
    title: 'Delegated follow-up task',
    status: 'idle',
  });
  await insertUserPrompt(page, childSessionId, 'Initial task');
  await insertAssistantText(page, childSessionId, 'Initial task done.');

  const sendResult = await callMetaAgentTool<{
    sessionId: string;
    prompt: string;
    bypassedExecutionForTest?: boolean;
  }>(metaAgentClient, 'send_prompt', {
    sessionId: childSessionId,
    prompt: 'Now do the follow-up work',
  });
  expect(sendResult.sessionId).toBe(childSessionId);
  expect(sendResult.prompt).toBe('Now do the follow-up work');
  expect(sendResult.bypassedExecutionForTest).toBe(true);

  const result = await callMetaAgentTool<{
    sessionId: string;
    userPrompts: string[];
  }>(metaAgentClient, 'get_session_result', { sessionId: childSessionId });
  expect(result.userPrompts).toContain('Now do the follow-up work');
});

test('list_queued_prompts exposes bounded queue state for a child session', async () => {
  const childSessionId = await createLinkedTestSession({
    title: 'Queued prompt audit task',
    status: 'running',
  });

  await callMetaAgentTool(metaAgentClient, 'send_prompt', {
    sessionId: childSessionId,
    prompt: 'This prompt should remain queued for inspection',
  });

  const queue = await callMetaAgentTool<{
    sessionId: string;
    count: number;
    prompts: Array<{
      id: string;
      status: string;
      promptPreview: string;
      prompt?: string;
    }>;
  }>(metaAgentClient, 'list_queued_prompts', {
    sessionId: childSessionId,
  });

  expect(queue.sessionId).toBe(childSessionId);
  expect(queue.count).toBeGreaterThanOrEqual(1);
  expect(queue.prompts[0].status).toBe('pending');
  expect(queue.prompts[0].promptPreview).toContain('remain queued');
  expect(queue.prompts[0].prompt).toBeUndefined();
});

test('send_prompt rejects empty or missing prompt', async () => {
  const childSessionId = await createLinkedTestSession({
    title: 'Empty prompt guard',
    status: 'idle',
  });

  await expect(
    callMetaAgentTool(metaAgentClient, 'send_prompt', {
      sessionId: childSessionId,
      prompt: '',
    })
  ).rejects.toThrow(/prompt is required/i);

  await expect(
    callMetaAgentTool(metaAgentClient, 'send_prompt', {
      sessionId: childSessionId,
      prompt: '   ',
    })
  ).rejects.toThrow(/prompt is required/i);
});

test('get_session_status returns error for non-existent session', async () => {
  await expect(
    callMetaAgentTool(metaAgentClient, 'get_session_status', {
      sessionId: 'non-existent-session-id',
    })
  ).rejects.toThrow(/not found/i);
});

test('create_session rejects conflicting useWorktree and worktreeId', async () => {
  await expect(
    callMetaAgentTool(metaAgentClient, 'create_session', {
      title: 'Conflicting worktree args',
      prompt: 'test',
      useWorktree: true,
      worktreeId: 'some-worktree-id',
    })
  ).rejects.toThrow(/cannot be combined/i);
});
