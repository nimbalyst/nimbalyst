/**
 * Auth-rejection E2E for the internal MCP HTTP servers.
 *
 * Issue #146: every internal MCP server must require a per-launch bearer token
 * so a malicious page open in the user's browser cannot fire side-effecting
 * tool calls at the localhost ports. This test boots the app, derives the
 * meta-agent server port (existing test-only IPC), and verifies that:
 *   1. An anonymous request returns 401 (no Authorization header).
 *   2. A request with a wrong token returns 401.
 *   3. A request with the correct token succeeds (initialize handshake).
 *
 * The token is fetched via a test-only `mcp:get-auth-token` IPC handler, the
 * same pattern used for `meta-agent:get-server-port`.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  createTempWorkspace,
  launchElectronApp,
  waitForAppReady,
} from '../helpers';
import { dismissAPIKeyDialog } from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

async function invokeElectron<T>(channel: string, ...args: unknown[]): Promise<T> {
  return await page.evaluate(
    async ({ invokeChannel, invokeArgs }) => {
      return await (window as any).electronAPI.invoke(invokeChannel, ...invokeArgs);
    },
    { invokeChannel: channel, invokeArgs: args }
  );
}

async function getMetaAgentServerPort(): Promise<number> {
  const result = await invokeElectron<{ success: boolean; port: number | null }>(
    'meta-agent:get-server-port',
  );
  if (!result.success || !result.port) {
    throw new Error(`Meta-agent MCP server port unavailable: ${JSON.stringify(result)}`);
  }
  return result.port;
}

async function getMcpAuthToken(): Promise<string> {
  const result = await invokeElectron<{ success: boolean; token: string | null }>(
    'mcp:get-auth-token',
  );
  if (!result.success || !result.token) {
    throw new Error(`MCP auth token unavailable: ${JSON.stringify(result)}`);
  }
  return result.token;
}

const INITIALIZE_PAYLOAD = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-auth-spec', version: '1.0.0' },
  },
};

async function postInitialize(port: number, headers: Record<string, string>): Promise<Response> {
  // The meta-agent server expects sessionId and workspaceId on the URL when
  // a new MCP session is being initialized. We pass placeholders so the
  // happy-path test reaches the initialize handler -- the auth check runs
  // before any of that.
  // Run the fetch from the Node test process so the request really is
  // anonymous (no preload, no IPC, no implicit token plumbing).
  const url = `http://127.0.0.1:${port}/mcp?sessionId=auth-spec&workspaceId=${encodeURIComponent(workspacePath)}`;
  return await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(INITIALIZE_PAYLOAD),
  });
}

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();
  await fs.writeFile(path.join(workspacePath, 'README.md'), '# MCP Auth Test\n', 'utf8');
  execSync('git init', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git add .', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: workspacePath, stdio: 'pipe' });

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    permissionMode: 'allow-all',
  });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await dismissAPIKeyDialog(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

test('anonymous requests to the meta-agent MCP server are rejected with 401', async () => {
  const port = await getMetaAgentServerPort();
  const response = await postInitialize(port, {});
  expect(response.status).toBe(401);
});

test('wrong-token requests to the meta-agent MCP server are rejected with 401', async () => {
  const port = await getMetaAgentServerPort();
  const response = await postInitialize(port, {
    Authorization: 'Bearer this-is-not-the-real-token',
  });
  expect(response.status).toBe(401);
});

test('correct-token requests to the meta-agent MCP server succeed', async () => {
  const port = await getMetaAgentServerPort();
  const token = await getMcpAuthToken();
  const response = await postInitialize(port, {
    Authorization: `Bearer ${token}`,
  });
  // The MCP transport responds 200 to a valid initialize. We don't read the
  // body here -- the assertion is purely that auth was accepted.
  expect(response.status).toBe(200);
});
