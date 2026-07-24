import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  TEST_TIMEOUTS,
} from '../helpers';
import {
  createTestSession,
  insertMessage,
  cleanupTestSessions,
} from '../utils/interactivePromptTestHelpers';
import {
  switchToAgentMode,
  PLAYWRIGHT_TEST_SELECTORS,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

function acpUpdateEnvelope(update: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'session/update',
    sessionId: 'codex-acp-session',
    update,
  });
}

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();
  await fs.writeFile(
    path.join(workspacePath, 'test.md'),
    '# Test Document\n\nHello world.\n',
    'utf8'
  );

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    permissionMode: 'allow-all',
    env: { PLAYWRIGHT_TEST: 'true' },
  });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await switchToAgentMode(page);
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  if (page) {
    await cleanupTestSessions(page, workspacePath);
  }
  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

test('coalesces chunked Codex ACP assistant output into one transcript bubble', async () => {
  const sessionId = await createTestSession(page, workspacePath, {
    title: 'Codex ACP chunked transcript',
    provider: 'openai-codex-acp',
    model: 'openai-codex-acp:gpt-5.5',
  });

  await insertMessage(page, sessionId, 'input', 'testing. say hi', {
    source: 'openai-codex-acp',
  });

  for (const text of ['I', "'m ", 'reading ', 'the ', 'repo ', 'instructions ', 'first, ', 'hi']) {
    await insertMessage(page, sessionId, 'output', acpUpdateEnvelope({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    }), {
      source: 'openai-codex-acp',
    });
  }

  await insertMessage(page, sessionId, 'output', acpUpdateEnvelope({
    sessionUpdate: 'usage_update',
    used: 42,
    size: 100,
  }), {
    source: 'openai-codex-acp',
  });

  await page.waitForTimeout(1000);

  const sessionItem = page.locator(`#session-list-item-${sessionId}`);
  await expect(sessionItem).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
  await sessionItem.click();
  await page.waitForTimeout(1000);

  const userBubble = page.locator('.rich-transcript-message.user');
  await expect(userBubble.first()).toContainText('testing. say hi');

  const assistantBubbles = page.locator('.rich-transcript-message.assistant');
  await expect(assistantBubbles).toHaveCount(1);
  await expect(assistantBubbles.first()).toContainText("I'm reading the repo instructions first, hi");

  const transcriptMessages = page.locator(PLAYWRIGHT_TEST_SELECTORS.richTranscriptMessage);
  await expect(transcriptMessages).toHaveCount(2);
});
