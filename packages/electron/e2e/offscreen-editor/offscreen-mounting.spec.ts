/**
 * E2E test for offscreen editor mounting system
 *
 * Single comprehensive test that validates the complete workflow:
 * mounting, caching, screenshots, and performance baselines.
 */

import { test, expect, ElectronApplication, Page } from '@playwright/test';
import { launchElectronApp, createTempWorkspace, waitForAppReady } from '../helpers';
import * as fs from 'fs/promises';
import * as path from 'path';

const COLD_MOUNT_BUDGET_MS = 6000;

test.describe('Offscreen Editor Mounting', () => {
  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceDir: string;
  let testDiagramPath: string;

  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    workspaceDir = await createTempWorkspace();

    // Create a test Excalidraw file BEFORE launching app
    testDiagramPath = path.join(workspaceDir, 'test-diagram.excalidraw');
    const emptyDiagram = {
      type: 'excalidraw',
      version: 2,
      source: 'https://excalidraw.com',
      elements: [],
      appState: {
        viewBackgroundColor: '#ffffff',
        collaborators: [],
      },
      files: {},
    };
    await fs.writeFile(testDiagramPath, JSON.stringify(emptyDiagram, null, 2), 'utf8');

    electronApp = await launchElectronApp({
      workspace: workspaceDir,
      permissionMode: 'allow-all',
    });
    page = await electronApp.firstWindow();
    await waitForAppReady(page);
  });

  test.afterAll(async () => {
    await electronApp?.close();
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  test('complete offscreen editor workflow: mount, cache, screenshot, and performance', async () => {
    console.log('[Test] Starting comprehensive offscreen editor test');
    console.log('[Test] Test diagram path:', testDiagramPath);

    // STEP 1: Verify initial state
    const fileExists = await fs.access(testDiagramPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    const tabSelector = `[data-testid="tab"][data-filepath="${testDiagramPath}"]`;
    const initialTabCount = await page.locator(tabSelector).count();
    expect(initialTabCount).toBe(0);
    console.log('[Test] ✓ File exists and is not open');

    // STEP 2: First mount - measure performance
    console.log('[Test] Step 2: First offscreen mount');
    const mount1Start = Date.now();

    const mount1Result = await page.evaluate(async (filePath) => {
      const electronAPI = (window as any).electronAPI;
      const result = await electronAPI.invoke('offscreen-editor:mount', {
        filePath,
        workspacePath: filePath.substring(0, filePath.lastIndexOf('/')),
      });
      return result;
    }, testDiagramPath);

    const mount1Duration = Date.now() - mount1Start;
    console.log(`[Test] ✓ First mount: ${mount1Duration}ms`);

    expect(mount1Result.success).toBe(true);
    // Cold mount includes the capture window's 1s initialization delay and
    // the editor's 3s settle delay before renderer readiness is assumed.
    expect(mount1Duration).toBeLessThan(COLD_MOUNT_BUDGET_MS);

    // STEP 3: Verify editor is available and cached
    const stats1 = await page.evaluate(async () => {
      const electronAPI = (window as any).electronAPI;
      const result = await electronAPI.invoke('offscreen-editor:get-stats');
      return result.stats;
    });

    expect(stats1.mounted).toBe(1);
    expect(stats1.cache).toHaveLength(1);
    console.log('[Test] ✓ Editor cached (ref count: 1)');

    // STEP 4: Second mount - verify cache reuse
    console.log('[Test] Step 4: Second mount (cache reuse test)');
    const mount2Start = Date.now();

    await page.evaluate(async (filePath) => {
      const electronAPI = (window as any).electronAPI;
      await electronAPI.invoke('offscreen-editor:mount', {
        filePath,
        workspacePath: filePath.substring(0, filePath.lastIndexOf('/')),
      });
    }, testDiagramPath);

    const mount2Duration = Date.now() - mount2Start;
    console.log(`[Test] ✓ Second mount (cached): ${mount2Duration}ms`);

    expect(mount2Duration).toBeLessThan(mount1Duration / 2); // Should be much faster

    const stats2 = await page.evaluate(async () => {
      const electronAPI = (window as any).electronAPI;
      const result = await electronAPI.invoke('offscreen-editor:get-stats');
      return result.stats;
    });

    expect(stats2.mounted).toBe(1);
    expect(stats2.cache[0].refCount).toBe(2); // Ref count incremented
    console.log('[Test] ✓ Cache reused (ref count: 2)');

    // STEP 5: Screenshot capture - measure performance
    console.log('[Test] Step 5: Screenshot capture');
    const screenshotStart = Date.now();

    const screenshotResult = await page.evaluate(async (filePath) => {
      const electronAPI = (window as any).electronAPI;
      const workspacePath = filePath.substring(0, filePath.lastIndexOf('/'));

      const result = await electronAPI.invoke('offscreen-editor:capture-screenshot', {
        filePath,
        workspacePath,
      });

      return {
        success: result.success,
        hasImage: !!result.imageBase64,
        imageSize: result.imageBase64?.length || 0,
        mimeType: result.mimeType,
      };
    }, testDiagramPath);

    const screenshotDuration = Date.now() - screenshotStart;
    console.log(`[Test] ✓ Screenshot captured: ${screenshotDuration}ms (${Math.round(screenshotResult.imageSize / 1024)}KB)`);

    expect(screenshotResult.success).toBe(true);
    expect(screenshotResult.hasImage).toBe(true);
    expect(screenshotResult.imageSize).toBeGreaterThan(0);
    expect(screenshotResult.mimeType).toBe('image/png');
    expect(screenshotDuration).toBeLessThan(2000); // Performance baseline

    // STEP 6: Verify file still not open in tabs
    const tabCountAfterOps = await page.locator(tabSelector).count();
    expect(tabCountAfterOps).toBe(0);
    console.log('[Test] ✓ File never opened in visible tab (true offscreen operation)');

    // STEP 7: Unmount and verify ref counting
    console.log('[Test] Step 7: Testing unmount and ref counting');

    await page.evaluate(async (filePath) => {
      const electronAPI = (window as any).electronAPI;
      await electronAPI.invoke('offscreen-editor:unmount', { filePath });
    }, testDiagramPath);

    const stats3 = await page.evaluate(async () => {
      const electronAPI = (window as any).electronAPI;
      const result = await electronAPI.invoke('offscreen-editor:get-stats');
      return result.stats;
    });

    expect(stats3.mounted).toBe(1); // Still mounted (ref count = 1)
    console.log('[Test] ✓ Editor kept alive after first unmount (ref count: 1)');

    // Performance Summary
    console.log('\n[Test] ═══════════════════════════════════════');
    console.log('[Test] Performance Baselines Established:');
    console.log('[Test] ═══════════════════════════════════════');
    console.log(`[Test] Initial mount:     ${mount1Duration}ms (target: <${COLD_MOUNT_BUDGET_MS}ms) ✓`);
    console.log(`[Test] Cached mount:      ${mount2Duration}ms (${Math.round(mount1Duration / mount2Duration)}x faster) ✓`);
    console.log(`[Test] Screenshot:        ${screenshotDuration}ms (target: <2000ms) ✓`);
    console.log(`[Test] Screenshot delta:  ${Math.round((COLD_MOUNT_BUDGET_MS - screenshotDuration) / COLD_MOUNT_BUDGET_MS * 100)}% below cold-mount budget`);
    console.log('[Test] ═══════════════════════════════════════');
  });
});
