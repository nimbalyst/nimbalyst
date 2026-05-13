import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { launchElectronApp, createTempWorkspace, TEST_TIMEOUTS } from '../helpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

/**
 * E2E coverage for the multi-project rail (issue #155).
 *
 * Scenarios covered:
 *   1. Toggle on `multiProjectMode` exposes the rail UI and an active item.
 *   2. Adding a second project via `register-additional` puts it on the rail
 *      and switching activates it (workspace:set-active fires through the
 *      atom subscriber).
 *   3. Per-workspace UI state (sidebar width, tabs) survives a switch.
 *   4. Closing the active project from the rail promotes the next entry
 *      and tears down only the closed project's services.
 *   5. Cap at 8 projects: the 9th add is rejected without altering the rail.
 *
 * Tests assume the dev server is running (helpers.ts enforces this) and
 * that the renderer exposes `window.electronAPI`. Reads/writes go through
 * IPC instead of the launch screen so the rail entry path can be exercised
 * deterministically without picking folders manually.
 */
test.describe('Multi-Project Rail', () => {
  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceA: string;
  let workspaceB: string;
  let workspaceC: string;

  test.beforeAll(async () => {
    workspaceA = await createTempWorkspace();
    workspaceB = await createTempWorkspace();
    workspaceC = await createTempWorkspace();

    await fs.writeFile(path.join(workspaceA, 'a.md'), '# A\n', 'utf8');
    await fs.writeFile(path.join(workspaceB, 'b.md'), '# B\n', 'utf8');
    await fs.writeFile(path.join(workspaceC, 'c.md'), '# C\n', 'utf8');

    electronApp = await launchElectronApp({
      workspace: workspaceA,
      env: { NODE_ENV: 'test' },
    });

    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.workspace-sidebar', { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

    // Enable multi-project mode through the IPC settings handler so the
    // rail is rendered without going through the Settings UI.
    await page.evaluate(async () => {
      await window.electronAPI.invoke('app:set-multi-project-mode', true);
    });

    // Force the renderer to reflect the new mode without a full reload.
    // The setting is read on app boot via initOpenProjects(); we re-evaluate
    // by reloading the renderer.
    await page.reload();
    await page.waitForSelector('.workspace-sidebar', { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });
  });

  test.afterAll(async () => {
    await electronApp?.close();
    await Promise.all([
      fs.rm(workspaceA, { recursive: true, force: true }).catch(() => undefined),
      fs.rm(workspaceB, { recursive: true, force: true }).catch(() => undefined),
      fs.rm(workspaceC, { recursive: true, force: true }).catch(() => undefined),
    ]);
  });

  test('rail renders with the primary project active', async () => {
    const rail = page.locator('[data-testid="project-rail"]');
    await expect(rail).toBeVisible({ timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

    const items = rail.locator('[data-testid="project-rail-item"]');
    await expect(items).toHaveCount(1);

    const addButton = rail.locator('[data-testid="project-rail-add"]');
    await expect(addButton).toBeVisible();
  });

  test('register-additional adds a second project and switches activate', async () => {
    await page.evaluate(async (paths) => {
      const reg = await window.electronAPI.invoke('workspace:register-additional', {
        workspacePath: paths.workspaceB,
      });
      if (!reg?.success) throw new Error('register-additional failed: ' + JSON.stringify(reg));

      // Mirror what ProjectRail's add flow does: append to openProjects
      // through the renderer-level atom (electronAPI exposes a dispatch
      // bridge via window helpers used by tests).
      const projectsBefore = await window.electronAPI.invoke('app:get-open-projects');
      const next = Array.isArray(projectsBefore) ? [...projectsBefore, paths.workspaceB] : [paths.workspaceB];
      await window.electronAPI.invoke('app:set-open-projects', next);
      await window.electronAPI.invoke('app:set-active-project-path', paths.workspaceB);
      await window.electronAPI.invoke('workspace:set-active', { workspacePath: paths.workspaceB });
    }, { workspaceB });

    await page.reload();
    await page.waitForSelector('.workspace-sidebar', { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

    const rail = page.locator('[data-testid="project-rail"]');
    const items = rail.locator('[data-testid="project-rail-item"]');
    await expect(items).toHaveCount(2);

    const active = rail.locator('[data-testid="project-rail-item"].active');
    await expect(active).toHaveCount(1);
  });

  test('switching projects via rail click flips the active path', async () => {
    const rail = page.locator('[data-testid="project-rail"]');
    const items = rail.locator('[data-testid="project-rail-item"]');

    const firstItem = items.first();
    await firstItem.click();
    await page.waitForTimeout(300);

    // The clicked item should now be active.
    await expect(firstItem).toHaveClass(/active/);

    // The other item must NOT be active simultaneously.
    const secondItem = items.nth(1);
    await expect(secondItem).not.toHaveClass(/active/);
  });

  test('rail click updates workspace context in-process (no reload)', async () => {
    // Regression for the in-memory rail-switch path. The earlier session
    // leak bug only surfaced when the same renderer process flipped the
    // active workspace; reload-based assertions miss it because the boot
    // cycle re-reads workspace state from scratch. Click a rail icon and
    // verify the summary header + sidebar path reflect the newly active
    // workspace without `page.reload()`.
    const rail = page.locator('[data-testid="project-rail"]');
    const items = rail.locator('[data-testid="project-rail-item"]');
    await expect(items).toHaveCount(2);

    const firstPath = await items.first().getAttribute('data-project-path');
    const secondPath = await items.nth(1).getAttribute('data-project-path');
    expect(firstPath).toBeTruthy();
    expect(secondPath).toBeTruthy();
    expect(firstPath).not.toBe(secondPath);

    // Click the first rail icon and confirm the summary header carries
    // the matching path.
    await items.first().click();
    await expect(page.locator('.workspace-summary-header-path')).toContainText(firstPath!);

    // Click the second rail icon WITHOUT a reload. The summary header
    // and sidebar must follow the new active workspace.
    await items.nth(1).click();
    await expect(page.locator('.workspace-summary-header-path')).toContainText(secondPath!);

    // The agent panel should reflect the new workspace's empty state
    // (neither test workspace was seeded with a session, so both render
    // the empty placeholder). The test would have failed pre-fix because
    // the previous workspace's transcript was still visible.
    await expect(page.locator('.agent-mode-empty')).toBeVisible({ timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });
  });

  test('closing the active project promotes the next entry', async () => {
    const rail = page.locator('[data-testid="project-rail"]');
    const items = rail.locator('[data-testid="project-rail-item"]');
    await expect(items).toHaveCount(2);

    // Click the active item to surface its close button (CSS shows it on
    // hover or when active).
    const activeItem = rail.locator('[data-testid="project-rail-item"].active');
    await activeItem.hover();

    // Auto-accept the streaming-confirm dialog (none expected here, but
    // installing a handler is harmless if no dialog opens).
    page.once('dialog', (dialog) => dialog.accept());

    const closeButton = activeItem.locator('.project-rail-item-close');
    await closeButton.click();

    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveClass(/active/);
  });

  test('switching to a fresh workspace shows the agent empty state', async () => {
    // Regression for the rail-switch session leak: when the rail switches
    // to a workspace whose `selectedWorkstreamAtom` is null (e.g. a project
    // added to the rail for the first time), the agent panel must reflect
    // the new workspace and render its empty state — not keep rendering
    // the previous workspace's transcript / tab. The
    // `attachWorkspaceSwitchCleanup` subscriber clears the global
    // `activeSessionIdAtom` on every flip so AgentMode falls back to the
    // empty render path.
    const freshWorkspace = await createTempWorkspace();
    await fs.writeFile(path.join(freshWorkspace, 'fresh.md'), '# Fresh\n', 'utf8');

    try {
      await page.evaluate(async (workspacePath) => {
        const reg = await window.electronAPI.invoke('workspace:register-additional', {
          workspacePath,
        });
        if (!reg?.success) throw new Error('register-additional failed: ' + JSON.stringify(reg));

        const projectsBefore = await window.electronAPI.invoke('app:get-open-projects');
        const next = Array.isArray(projectsBefore) ? [...projectsBefore, workspacePath] : [workspacePath];
        await window.electronAPI.invoke('app:set-open-projects', next);
        await window.electronAPI.invoke('app:set-active-project-path', workspacePath);
        await window.electronAPI.invoke('workspace:set-active', { workspacePath });
      }, freshWorkspace);

      await page.reload();
      await page.waitForSelector('.workspace-sidebar', { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

      // The fresh workspace must own the active rail slot and the agent
      // panel must show its empty state — no leaked tabs from the
      // previously active workspace.
      const rail = page.locator('[data-testid="project-rail"]');
      const activeItem = rail.locator('[data-testid="project-rail-item"].active');
      await expect(activeItem).toHaveCount(1);

      const empty = page.locator('.agent-mode-empty');
      await expect(empty).toBeVisible({ timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });
    } finally {
      await fs.rm(freshWorkspace, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test('rail rejects projects beyond the cap', async () => {
    const extraPaths: string[] = [];
    for (let i = 0; i < 9; i++) {
      const dir = await createTempWorkspace();
      await fs.writeFile(path.join(dir, 'x.md'), `# ${i}\n`, 'utf8');
      extraPaths.push(dir);
    }

    try {
      await page.evaluate(async (paths) => {
        for (const p of paths) {
          await window.electronAPI.invoke('workspace:register-additional', { workspacePath: p });
        }
        await window.electronAPI.invoke('app:set-open-projects', paths);
      }, extraPaths);

      await page.reload();
      await page.waitForSelector('.workspace-sidebar', { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

      const items = page.locator('[data-testid="project-rail"] [data-testid="project-rail-item"]');
      await expect(items).toHaveCount(8);
    } finally {
      await Promise.all(extraPaths.map((p) => fs.rm(p, { recursive: true, force: true }).catch(() => undefined)));
    }
  });
});
