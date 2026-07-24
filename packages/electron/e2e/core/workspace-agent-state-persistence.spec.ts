import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { launchElectronApp, createTempWorkspace, TEST_TIMEOUTS } from '../helpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

test.describe('Workspace-Agent Window State Persistence', () => {
  let workspacePath: string;

  test.beforeAll(async () => {
    workspacePath = await createTempWorkspace();

    await fs.writeFile(
      path.join(workspacePath, 'test1.md'),
      '# Test Document 1\n\nContent for test 1\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(workspacePath, 'test2.md'),
      '# Test Document 2\n\nContent for test 2\n',
      'utf8'
    );

    const planPath = path.join(workspacePath, 'plan.md');
    await fs.writeFile(planPath, `---
planStatus:
  planId: test-plan
  title: Test Plan
  status: draft
  planType: feature
  priority: high
---
# Test Plan

## Goals
- Test workspace-agent state persistence
`);
  });

  test.afterAll(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  });

  test('should preserve workspace tabs after opening agent window and reopening', async () => {
    test.setTimeout(30000);

    // Launch app
    let electronApp = await launchElectronApp({
      workspace: workspacePath,
      env: { NODE_ENV: 'test', ENABLE_SESSION_RESTORE: '1' },
    });

    let page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.workspace-sidebar', { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

    // Open test files to create tabs
    await page.locator('.file-tree-name', { hasText: 'test1.md' }).first().waitFor({ timeout: TEST_TIMEOUTS.FILE_TREE_LOAD });
    await page.locator('.file-tree-name', { hasText: 'test1.md' }).click();
    await page.waitForTimeout(500);
    await page.locator('.file-tree-name', { hasText: 'test2.md' }).click();
    await page.waitForTimeout(500);
    await page.locator('.file-tree-name', { hasText: 'plan.md' }).click();
    await page.waitForTimeout(500);

    const tabsBefore = await page.locator('.file-tabs-container .tab').count();
    expect(tabsBefore).toBe(3);

    // Open agentic coding window
    const planPath = path.join(workspacePath, 'plan.md');
    await page.evaluate(async ({ workspacePath, planDocumentPath }) => {
      await window.electronAPI.invoke('agentic-coding:create-window', {
        workspacePath,
        planDocumentPath
      });
    }, { workspacePath, planDocumentPath: planPath });
    await page.waitForTimeout(2000);

    expect(electronApp.windows().length).toBe(2);

    // Close and reopen
    await electronApp.close();
    await new Promise(resolve => setTimeout(resolve, 1000));

    electronApp = await launchElectronApp({
      workspace: workspacePath,
      env: { NODE_ENV: 'test', ENABLE_SESSION_RESTORE: '1' },
    });
    await new Promise(resolve => setTimeout(resolve, 3000));

    const windows = electronApp.windows();
    const restoredWorkspace = windows.find(w =>
      w.url().includes('mode=workspace') || !w.url().includes('mode=')
    );
    expect(restoredWorkspace).toBeDefined();
    if (!restoredWorkspace) throw new Error('Workspace window not found');

    await restoredWorkspace.waitForLoadState('domcontentloaded');
    await restoredWorkspace.waitForTimeout(2000);

    // Tabs should survive the restart
    const tabsAfter = await restoredWorkspace.locator('.file-tabs-container .tab').count();
    expect(tabsAfter).toBeGreaterThanOrEqual(3);

    const tabTexts = await restoredWorkspace.locator('.file-tabs-container .tab').allTextContents();
    expect(tabTexts.some(t => t.includes('test1.md'))).toBe(true);
    expect(tabTexts.some(t => t.includes('test2.md'))).toBe(true);
    expect(tabTexts.some(t => t.includes('plan.md'))).toBe(true);

    // Workspace should not have become an agent window
    const hasSidebar = await restoredWorkspace.locator('.workspace-sidebar').isVisible().catch(() => false);
    expect(hasSidebar).toBe(true);

    await electronApp.close();
  });
});
