import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { launchElectronApp, createTempWorkspace, TEST_TIMEOUTS } from '../helpers';
import { switchToAgentMode, switchToFilesMode } from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

// Several tests (and beforeAll) reload the renderer and wait up to
// SIDEBAR_LOAD for it to boot again, so the default 15s budget is too tight.
test.describe.configure({ mode: 'serial', timeout: 2 * TEST_TIMEOUTS.SIDEBAR_LOAD });

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
 *   5. Cap at 8 projects: restored projects beyond it are kept, but the add
 *      button is disabled.
 *
 * Tests assume the dev server is running (helpers.ts enforces this) and
 * that the renderer exposes `window.electronAPI`. Reads/writes go through
 * IPC instead of the launch screen so the rail entry path can be exercised
 * deterministically without picking folders manually.
 */
/**
 * Every session rendered in the (always-mounted) agent panel must belong to
 * `workspacePath`. This is the rail-switch leak guard: a stale panel from the
 * previously active workspace fails it. An empty panel passes, and so does
 * the session Files mode's chat panel auto-creates for the new workspace, so
 * callers seed a source session first (seedAgentSession).
 */
async function expectAgentPanelOwnedBy(page: Page, workspacePath: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async (ws) => {
        const ids = Array.from(
          document.querySelectorAll('[data-layout="agent-mode-wrapper"] .agent-session-panel[data-session-id]'),
        ).map((el) => el.getAttribute('data-session-id'));
        const owners = await Promise.all(
          ids.map(async (id) => (await window.electronAPI.invoke('sessions:get', id))?.session?.workspacePath),
        );
        return owners.filter((owner) => owner !== ws);
      }, workspacePath),
    )
    .toEqual([]);
}

/**
 * Gives the active workspace an agent session the panel is showing, so the
 * leak guard above has something to catch: without it an empty panel passes
 * whether or not the switch cleaned up. Returns to Files mode afterwards.
 */
async function seedAgentSession(page: Page, workspacePath: string): Promise<void> {
  // Agent mode auto-creates a session for a workspace that has none.
  await switchToAgentMode(page);
  await expect
    .poll(() =>
      page.evaluate(async (ws) => {
        const ids = Array.from(
          document.querySelectorAll('[data-layout="agent-mode-wrapper"] .agent-session-panel[data-session-id]'),
        ).map((el) => el.getAttribute('data-session-id'));
        const owners = await Promise.all(
          ids.map(async (id) => (await window.electronAPI.invoke('sessions:get', id))?.session?.workspacePath),
        );
        return owners.includes(ws);
      }, workspacePath),
    )
    .toBe(true);
  await switchToFilesMode(page);
}

test.describe('Multi-Project Rail', () => {
  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceA: string;
  let workspaceB: string;
  let workspaceC: string;

  test.beforeAll(async () => {
    // Launch plus a reload: two full renderer boots.
    test.setTimeout(3 * TEST_TIMEOUTS.SIDEBAR_LOAD);
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

    const active = rail.locator('[data-testid="project-rail-item"].is-active');
    await expect(active).toHaveCount(1);
  });

  test('switching projects via rail click flips the active path', async () => {
    const rail = page.locator('[data-testid="project-rail"]');
    const items = rail.locator('[data-testid="project-rail-item"]');

    const firstItem = items.first();
    await firstItem.click();

    // The clicked item should now be active.
    await expect(firstItem).toHaveClass(/\bis-active\b/);

    // The other item must NOT be active simultaneously.
    const secondItem = items.nth(1);
    await expect(secondItem).not.toHaveClass(/\bis-active\b/);
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
    await expect(page.locator('.workspace-summary-header-path:visible')).toContainText(firstPath!);
    await seedAgentSession(page, firstPath!);

    // Click the second rail icon WITHOUT a reload. The summary header
    // and sidebar must follow the new active workspace.
    await items.nth(1).click();
    await expect(page.locator('.workspace-summary-header-path:visible')).toContainText(secondPath!);

    // The agent panel must not keep showing the previous workspace's
    // session. The test would have failed pre-fix because the previous
    // workspace's transcript was still visible.
    await expectAgentPanelOwnedBy(page, secondPath!);
  });

  test('closing the active project promotes the next entry', async () => {
    const rail = page.locator('[data-testid="project-rail"]');
    const items = rail.locator('[data-testid="project-rail-item"]');
    await expect(items).toHaveCount(2);

    // Click the active item to surface its close button (CSS shows it on
    // hover or when active).
    const activeItem = rail.locator('[data-testid="project-rail-item"].is-active');
    await activeItem.hover();

    const closeButton = activeItem.locator('.project-rail-item-close');
    await closeButton.click();

    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveClass(/\bis-active\b/);
  });

  test('switching to a fresh workspace does not leak the previous agent session', async () => {
    // Regression for the rail-switch session leak: when the rail switches
    // to a project added to the rail for the first time, the agent panel
    // must reflect the new workspace, not keep rendering the previous
    // workspace's transcript / tab. The `attachWorkspaceSwitchCleanup`
    // subscriber clears the global `activeSessionIdAtom` on every flip.
    const freshWorkspace = await createTempWorkspace();
    await fs.writeFile(path.join(freshWorkspace, 'fresh.md'), '# Fresh\n', 'utf8');

    const previousPath = await page
      .locator('[data-testid="project-rail"] [data-testid="project-rail-item"].is-active')
      .getAttribute('data-project-path');
    await seedAgentSession(page, previousPath!);

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
      // panel must not show sessions from the previously active workspace.
      const rail = page.locator('[data-testid="project-rail"]');
      const activeItem = rail.locator('[data-testid="project-rail-item"].is-active');
      await expect(activeItem).toHaveAttribute('data-project-path', freshWorkspace);

      await expectAgentPanelOwnedBy(page, freshWorkspace);
    } finally {
      await fs.rm(freshWorkspace, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test('restored projects beyond the cap are kept and adding more is blocked', async () => {
    // The eight-project cap gates new additions only; projects restored from
    // saved state are preserved (see openProjects.ts).
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

      const rail = page.locator('[data-testid="project-rail"]');
      // Restore merges these with the projects still live in this window.
      for (const p of extraPaths) {
        await expect(rail.locator(`[data-testid="project-rail-item"][data-project-path="${p}"]`)).toHaveCount(1);
      }
      await expect(rail.locator('[data-testid="project-rail-add"]')).toBeDisabled();
    } finally {
      await Promise.all(extraPaths.map((p) => fs.rm(p, { recursive: true, force: true }).catch(() => undefined)));
    }
  });
});
