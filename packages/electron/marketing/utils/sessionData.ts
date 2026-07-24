/**
 * Marketing Session Data
 *
 * Injects realistic AI session data into the database for marketing screenshots.
 * Uses the same test:insert-session / test:insert-message IPC as E2E tests.
 */

import type { Page } from 'playwright';

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function createSession(
  page: Page,
  workspacePath: string,
  options: { title: string; provider?: string; model?: string }
): Promise<string> {
  const sessionId = generateId();
  const result = await page.evaluate(
    async ({ sessionId, workspacePath, title, provider, model }) => {
      return await (window as any).electronAPI.invoke('test:insert-session', {
        id: sessionId,
        workspaceId: workspacePath,
        title,
        provider: provider || 'claude-code',
        model: model || 'claude-sonnet-4-5-20250929',
      });
    },
    {
      sessionId,
      workspacePath,
      title: options.title,
      provider: options.provider,
      model: options.model,
    }
  );

  if (!result.success) {
    throw new Error(`Failed to create session: ${result.error}`);
  }

  return sessionId;
}

async function insertMessage(
  page: Page,
  sessionId: string,
  direction: 'input' | 'output',
  content: string,
  source = 'claude-code'
): Promise<string> {
  const result = await page.evaluate(
    async ({ sessionId, direction, content, source }) => {
      return await (window as any).electronAPI.invoke('test:insert-message', {
        sessionId,
        direction,
        content,
        source,
      });
    },
    { sessionId, direction, content, source }
  );

  if (!result.success) {
    throw new Error(`Failed to insert message: ${result.error}`);
  }

  return result.id;
}

// --- Message format helpers ---

function userPrompt(text: string): string {
  return JSON.stringify({ prompt: text, options: {} });
}

function assistantText(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

function toolUse(name: string, id: string, input: Record<string, any>): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id, name, input }],
    },
  });
}

function toolResult(toolUseId: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: [{ type: 'text', text: content }],
        },
      ],
    },
  });
}

function nimbalystToolUse(name: string, id: string, input: Record<string, any>): string {
  return JSON.stringify({
    type: 'nimbalyst_tool_use',
    id,
    name,
    input,
  });
}

// --- Public API ---

/**
 * Populate the database with a rich set of sessions for marketing screenshots.
 * Returns the primary session ID (the one with a full transcript).
 */
export async function populateMarketingSessions(
  page: Page,
  workspacePath: string
): Promise<{ primarySessionId: string; allSessionIds: string[] }> {
  const allSessionIds: string[] = [];

  // === Primary Session: Full transcript with tool calls ===
  const primarySessionId = await createSession(page, workspacePath, {
    title: 'Refactor authentication middleware',
    model: 'claude-sonnet-4-5-20250929',
  });
  allSessionIds.push(primarySessionId);

  // User prompt
  await insertMessage(
    page,
    primarySessionId,
    'input',
    userPrompt(
      'Help me refactor the authentication middleware to support both JWT and API key auth. The current implementation only handles JWT tokens.'
    )
  );

  // Assistant response
  await insertMessage(
    page,
    primarySessionId,
    'output',
    assistantText(
      "I'll refactor the authentication middleware to support both JWT and API key authentication. Let me start by reading the current implementation.\n\nHere's my plan:\n1. Read the existing middleware\n2. Create a unified auth interface\n3. Implement JWT and API key strategies\n4. Update the middleware to use the new pattern"
    )
  );

  // Tool call: Read file
  const readId = `toolu_read_${generateId().slice(0, 8)}`;
  await insertMessage(
    page,
    primarySessionId,
    'output',
    toolUse('Read', readId, { file_path: 'src/auth/middleware.ts' })
  );

  // Tool result
  await insertMessage(
    page,
    primarySessionId,
    'input',
    toolResult(
      readId,
      `import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}`
    )
  );

  // Assistant explanation
  await insertMessage(
    page,
    primarySessionId,
    'output',
    assistantText(
      "I can see the current middleware only handles JWT. I'll create a strategy pattern that supports both authentication methods. Let me write the new implementation."
    )
  );

  // Tool call: Write file
  const writeId = `toolu_write_${generateId().slice(0, 8)}`;
  await insertMessage(
    page,
    primarySessionId,
    'output',
    toolUse('Write', writeId, {
      file_path: 'src/auth/middleware.ts',
      content: `import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

interface AuthStrategy {
  name: string;
  authenticate(req: Request): Promise<AuthResult>;
}

interface AuthResult {
  success: boolean;
  user?: { id: string; email: string; role: string };
  error?: string;
}

const jwtStrategy: AuthStrategy = {
  name: 'jwt',
  async authenticate(req) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return { success: false, error: 'No token provided' };
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      return { success: true, user: decoded };
    } catch {
      return { success: false, error: 'Invalid JWT token' };
    }
  }
};

const apiKeyStrategy: AuthStrategy = {
  name: 'api-key',
  async authenticate(req) {
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) return { success: false, error: 'No API key provided' };
    const user = await validateApiKey(apiKey);
    if (!user) return { success: false, error: 'Invalid API key' };
    return { success: true, user };
  }
};

const strategies: AuthStrategy[] = [jwtStrategy, apiKeyStrategy];

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  for (const strategy of strategies) {
    const result = await strategy.authenticate(req);
    if (result.success) {
      req.user = result.user;
      return next();
    }
  }
  return res.status(401).json({ error: 'Authentication failed' });
}`,
    })
  );

  // Tool result
  await insertMessage(
    page,
    primarySessionId,
    'input',
    toolResult(writeId, 'File written successfully: src/auth/middleware.ts')
  );

  // Follow-up assistant message
  await insertMessage(
    page,
    primarySessionId,
    'output',
    assistantText(
      "I've refactored the middleware with a strategy pattern. The new implementation:\n\n- **`AuthStrategy` interface** - defines a contract for auth methods\n- **`jwtStrategy`** - handles Bearer token authentication\n- **`apiKeyStrategy`** - handles X-API-Key header authentication\n- **`authMiddleware`** - tries each strategy in order, succeeding on first match\n\nWould you like me to add tests for both authentication paths?"
    )
  );

  // User follow-up
  await insertMessage(
    page,
    primarySessionId,
    'input',
    userPrompt('Yes, please add tests for both auth methods.')
  );

  // === Additional sessions for session history ===

  // Today
  await createSession(page, workspacePath, {
    title: 'Add rate limiting to API endpoints',
    model: 'claude-sonnet-4-5-20250929',
  }).then((id) => allSessionIds.push(id));

  await createSession(page, workspacePath, {
    title: 'Fix WebSocket reconnection logic',
    model: 'claude-sonnet-4-5-20250929',
  }).then((id) => allSessionIds.push(id));

  // Yesterday (we can't control timestamps via test:insert-session, but titles suggest recency)
  await createSession(page, workspacePath, {
    title: 'Optimize database query performance',
    model: 'claude-opus-4-6',
  }).then((id) => allSessionIds.push(id));

  await createSession(page, workspacePath, {
    title: 'Write API documentation with OpenAPI spec',
    model: 'claude-sonnet-4-5-20250929',
  }).then((id) => allSessionIds.push(id));

  await createSession(page, workspacePath, {
    title: 'Set up CI/CD pipeline with GitHub Actions',
    model: 'claude-sonnet-4-5-20250929',
  }).then((id) => allSessionIds.push(id));

  // This week
  await createSession(page, workspacePath, {
    title: 'Implement user role permissions',
    model: 'claude-sonnet-4-5-20250929',
  }).then((id) => allSessionIds.push(id));

  await createSession(page, workspacePath, {
    title: 'Add error tracking with Sentry',
    model: 'claude-sonnet-4-5-20250929',
  }).then((id) => allSessionIds.push(id));

  await createSession(page, workspacePath, {
    title: 'Migrate database schema to v2',
    model: 'claude-opus-4-6',
  }).then((id) => allSessionIds.push(id));

  // Older
  await createSession(page, workspacePath, {
    title: 'Design extension API architecture',
    model: 'claude-opus-4-6',
  }).then((id) => allSessionIds.push(id));

  await createSession(page, workspacePath, {
    title: 'Performance optimization for file watcher',
    model: 'claude-sonnet-4-5-20250929',
  }).then((id) => allSessionIds.push(id));

  await createSession(page, workspacePath, {
    title: 'Build CSV export feature',
    model: 'claude-sonnet-4-5-20250929',
  }).then((id) => allSessionIds.push(id));

  return { primarySessionId, allSessionIds };
}

/**
 * Insert a pending AskUserQuestion into a session.
 */
export async function insertAskUserQuestion(
  page: Page,
  sessionId: string,
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>
): Promise<string> {
  const questionId = `question-${generateId()}`;
  const content = nimbalystToolUse('AskUserQuestion', questionId, { questions });
  await insertMessage(page, sessionId, 'output', content);
  return questionId;
}

/**
 * Insert a pending ToolPermission into a session.
 */
export async function insertToolPermission(
  page: Page,
  sessionId: string,
  toolName: string,
  rawCommand: string,
  pattern: string
): Promise<string> {
  const requestId = `tool-${generateId().slice(0, 8)}`;
  const content = nimbalystToolUse('ToolPermission', requestId, {
    requestId,
    toolName,
    rawCommand,
    pattern,
    patternDisplayName: pattern,
    isDestructive: false,
    warnings: [],
    workspacePath: '',
  });
  await insertMessage(page, sessionId, 'output', content);
  return requestId;
}

/**
 * Insert a pending ExitPlanMode into a session.
 */
export async function insertExitPlanMode(
  page: Page,
  sessionId: string,
  planFilePath?: string
): Promise<string> {
  const toolId = `toolu_${generateId().replace(/-/g, '')}`;
  const content = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: 'ExitPlanMode',
          input: { planFilePath },
        },
      ],
    },
  });
  await insertMessage(page, sessionId, 'output', content);
  return toolId;
}
