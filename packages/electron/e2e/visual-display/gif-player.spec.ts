/**
 * E2E Tests for GIF Player Controls
 *
 * Tests the GifPlayer by rendering it through the VisualDisplayWidget
 * via the display_to_user tool call inserted into a test session.
 *
 * Uses test:insert-session/message IPC channels to inject data.
 */

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
  insertUserPrompt,
  insertMessage,
  cleanupTestSessions,
} from '../utils/interactivePromptTestHelpers';
import { switchToAgentMode } from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let workspacePath: string;
let gifPath: string;

/**
 * Generate a proper animated GIF using omggif (installed in devDependencies).
 * Creates a 64x64 4-frame animation with solid colors.
 */
async function createTestGif(outputPath: string): Promise<void> {
  // Pre-built 64x64 animated GIF with 4 frames (red/green/blue/yellow), 300ms each
  // Generated with omggif and verified with gifuct-js
  const base64 = 'R0lGODlhQABAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAHgAAACwAAAAAQABAAIL/AAAA/wAAAP///wD/AP8A////gACAAP8DRwi63P4wykmrvTjrzbv/YCiOZGmeaKqubOu+cCzPdG3feK7vfO//wKBwSCwaj8ikcslsOp/QqHRKrVqv2Kx2y+16v+CwGJAAACH5BAAeAAAALAAAAABAAEAAgv8AAAD/AAAA////AP8A/wD///+AAIAA/wNHGLrc/jDKSau9OOvNu/9gKI5kaZ5oqq5s675wLM90bd94ru987//AoHBILBqPyKRyyWw6n9CodEqtWq/YrHbL7Xq/4LA4kAAAIfkEAB4AAAAsAAAAAEAAQACC/wAAAP8AAAD///8A/wD/AP///4AAgAD/A0coutz+MMpJq7046827/2AojmRpnmiqrmzrvnAsz3Rt33iu73zv/8CgcEgsGo/IpHLJbDqf0Kh0Sq1ar9isdsvter/gsFiQAAAh+QQAHgAAACwAAAAAQABAAIL/AAAA/wAAAP///wD/AP8A////gACAAP8DRzi63P4wykmrvTjrzbv/YCiOZGmeaKqubOu+cCzPdG3feK7vfO//wKBwSCwaj8ikcslsOp/QqHRKrVqv2Kx2y+16v+CweJAAADs=';
  const buffer = Buffer.from(base64, 'base64');
  await fs.writeFile(outputPath, buffer);
}

test.describe('GIF Player Controls', () => {
  test.beforeAll(async () => {
    workspacePath = await createTempWorkspace();

    await fs.writeFile(
      path.join(workspacePath, 'test.md'),
      '# Test\n',
      'utf8'
    );

    // Create the test GIF file in the workspace
    gifPath = path.join(workspacePath, 'test-animation.gif');
    await createTestGif(gifPath);

    app = await launchElectronApp({
      workspace: workspacePath,
      permissionMode: 'allow-all',
      env: { PLAYWRIGHT_TEST: 'true' },
    });
    page = await app.firstWindow();
    await waitForAppReady(page);

    // Switch to agent mode
    await switchToAgentMode(page);
    await page.waitForTimeout(500);
  });

  test.afterAll(async () => {
    if (page) {
      await cleanupTestSessions(page, workspacePath).catch(() => {});
    }
    if (app) {
      await app.close();
    }
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  });

  test('renders GIF with play/pause button and scrub bar', async () => {
    // Create a test session
    const sessionId = await createTestSession(page, workspacePath, {
      title: 'GIF Player Test'
    });

    // Insert a user prompt
    await insertUserPrompt(page, sessionId, 'Show me an animation');

    // Insert the display_to_user tool call as an assistant message
    const toolId = `toolu_giftest_${Date.now()}`;
    const toolCallContent = JSON.stringify({
      type: 'assistant',
      message: {
        id: `msg_${Date.now()}`,
        content: [{
          type: 'tool_use',
          id: toolId,
          name: 'display_to_user',
          input: {
            items: [{
              description: 'Test animated GIF',
              image: { path: gifPath }
            }]
          }
        }]
      }
    });
    await insertMessage(page, sessionId, 'output', toolCallContent, { source: 'claude-code' });

    // Insert the tool result
    const toolResultContent = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolId,
          content: [{ type: 'text', text: 'Displayed 1 item(s):\n- image: Test animated GIF' }]
        }]
      }
    });
    await insertMessage(page, sessionId, 'output', toolResultContent, { source: 'claude-code' });

    // Wait for the session to appear in the list, then click it
    await page.waitForTimeout(1000);
    const sessionItem = page.locator(`#session-list-item-${sessionId}`);
    await expect(sessionItem).toBeVisible({ timeout: 10000 });
    await sessionItem.click();

    // Wait for transcript to load and render
    await page.waitForTimeout(3000);

    // Look for the visual-display-widget which wraps GIF content
    const visualWidget = page.locator('.visual-display-widget');
    await expect(visualWidget).toBeVisible({ timeout: 15000 });

    // Look for the GIF player specifically (class="gif-player")
    const gifPlayer = page.locator('.gif-player');
    await expect(gifPlayer).toBeVisible({ timeout: 10000 });

    // Verify canvas is visible
    const canvas = gifPlayer.locator('canvas');
    await expect(canvas).toBeVisible();

    // Verify play/pause button
    const playPauseBtn = gifPlayer.locator('button[aria-label="Pause"], button[aria-label="Play"]');
    await expect(playPauseBtn).toBeVisible();

    // Verify scrub bar
    const scrubBar = gifPlayer.locator('input[type="range"]');
    await expect(scrubBar).toBeVisible();

    // Test play/pause toggle
    // The controls bar has stopPropagation so clicking it won't open the lightbox
    const pauseBtn = gifPlayer.locator('button[aria-label="Pause"]');
    await expect(pauseBtn).toBeVisible({ timeout: 5000 });

    // Click pause
    await pauseBtn.click();
    await page.waitForTimeout(300);
    await expect(gifPlayer.locator('button[aria-label="Play"]')).toBeVisible();

    // Click play
    await gifPlayer.locator('button[aria-label="Play"]').click();
    await page.waitForTimeout(300);
    await expect(gifPlayer.locator('button[aria-label="Pause"]')).toBeVisible();

    // Test scrub
    await gifPlayer.locator('button[aria-label="Pause"]').click();
    await page.waitForTimeout(200);
    const range = gifPlayer.locator('input[type="range"]');
    await range.fill((await range.getAttribute('max')) || '3');
    await page.waitForTimeout(300);
    await expect(gifPlayer.locator('button[aria-label="Play"]')).toBeVisible();
  });
});
