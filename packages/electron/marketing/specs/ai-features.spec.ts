/**
 * AI Feature Screenshots
 *
 * Showcase AI-powered editing, session management, and interactive prompts.
 * Each is captured in both dark and light themes.
 */

import { test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchMarketingApp,
  captureScreenshotBothThemes,
  openFile,
  switchToAgentMode,
  switchToFilesMode,
  openAIChatSidebar,
  pause,
} from '../utils/helpers';
import {
  populateMarketingSessions,
  insertAskUserQuestion,
  insertToolPermission,
  insertExitPlanMode,
} from '../utils/sessionData';
import * as fs from 'fs/promises';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;
let primarySessionId: string;

test.beforeAll(async () => {
  const result = await launchMarketingApp();
  electronApp = result.app;
  page = result.page;
  workspaceDir = result.workspaceDir;

  // Populate sessions
  const sessions = await populateMarketingSessions(page, workspaceDir);
  primarySessionId = sessions.primarySessionId;
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('ai-chat-sidebar - Files mode with AI chat conversation', async () => {
  await switchToFilesMode(page);
  await openFile(page, 'middleware.ts');
  await pause(page, 500);

  // Open the AI chat sidebar
  await openAIChatSidebar(page);
  await pause(page, 1000);

  await captureScreenshotBothThemes(electronApp, page, 'ai-chat-sidebar');
});

test('ai-agent-transcript - Agent mode showing rich transcript', async () => {
  await switchToAgentMode(page);
  await pause(page, 1000);

  // Select the primary session with the full transcript
  const sessionItem = page.locator('.session-list-item').first();
  const isVisible = await sessionItem.isVisible().catch(() => false);
  if (isVisible) {
    await sessionItem.click();
    await pause(page, 1500);
  }

  await captureScreenshotBothThemes(electronApp, page, 'ai-agent-transcript');
});

test('ai-session-history - Session list with multiple sessions', async () => {
  await switchToAgentMode(page);
  await pause(page, 500);

  // Make sure session history sidebar is visible
  const sessionHistory = page.locator('.session-history');
  await sessionHistory.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await pause(page, 500);

  await captureScreenshotBothThemes(electronApp, page, 'ai-session-history');
});

test('ai-diff-review - File with pending AI edits', async () => {
  await switchToFilesMode(page);

  // Open a code file and simulate a diff
  await openFile(page, 'middleware.ts');
  await pause(page, 500);

  // Use the AI tool simulator to create a pending diff
  try {
    await page.evaluate(async () => {
      const editorRegistry = (window as any).__editorRegistry;
      if (!editorRegistry) return;

      const filePath = editorRegistry.getActiveFilePath();
      if (!filePath) return;

      // Apply a replacement that will show diff visualization
      await editorRegistry.applyReplacements(filePath, [
        {
          oldText: "const header = req.headers.authorization;",
          newText: "const header = req.headers.authorization ?? req.headers['x-auth-token'];",
        },
      ]);
    });
    await pause(page, 1000);
  } catch {
    // If editor registry isn't available, the screenshot will still capture the editor
  }

  await captureScreenshotBothThemes(electronApp, page, 'ai-diff-review');
});

test('ai-permission-dialog - Tool permission confirmation', async () => {
  await switchToAgentMode(page);
  await pause(page, 500);

  // Select the primary session
  const sessionItem = page.locator('.session-list-item').first();
  const isVisible = await sessionItem.isVisible().catch(() => false);
  if (isVisible) {
    await sessionItem.click();
    await pause(page, 1000);
  }

  // Insert a pending tool permission request
  try {
    await insertToolPermission(
      page,
      primarySessionId,
      'Bash',
      'npm test -- --coverage',
      'Bash(npm test*)'
    );
    await pause(page, 1000);

    // Scroll to the bottom of the transcript to show the permission widget
    await page.evaluate(() => {
      const transcript = document.querySelector('.rich-transcript-view');
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
    await pause(page, 500);
  } catch {
    // Proceed with screenshot even if injection fails
  }

  await captureScreenshotBothThemes(electronApp, page, 'ai-permission-dialog');
});

test('ai-ask-user-question - Interactive question widget', async () => {
  await switchToAgentMode(page);
  await pause(page, 500);

  // Insert a pending AskUserQuestion
  try {
    await insertAskUserQuestion(page, primarySessionId, [
      {
        question: 'Which authentication strategy should be the default?',
        header: 'Auth strategy',
        options: [
          { label: 'JWT tokens (Recommended)', description: 'Standard Bearer token authentication, best for web applications' },
          { label: 'API keys', description: 'Static keys for server-to-server communication' },
          { label: 'OAuth 2.0', description: 'Third-party provider authentication with PKCE flow' },
        ],
        multiSelect: false,
      },
    ]);
    await pause(page, 1000);

    // Scroll to bottom
    await page.evaluate(() => {
      const transcript = document.querySelector('.rich-transcript-view');
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
    await pause(page, 500);
  } catch {
    // Proceed
  }

  await captureScreenshotBothThemes(electronApp, page, 'ai-ask-user-question');
});

test('ai-plan-mode - Plan approval widget', async () => {
  await switchToAgentMode(page);
  await pause(page, 500);

  // Insert a pending ExitPlanMode
  try {
    await insertExitPlanMode(page, primarySessionId, 'plans/v2-migration.md');
    await pause(page, 1000);

    // Scroll to bottom
    await page.evaluate(() => {
      const transcript = document.querySelector('.rich-transcript-view');
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
    await pause(page, 500);
  } catch {
    // Proceed
  }

  await captureScreenshotBothThemes(electronApp, page, 'ai-plan-mode');
});
