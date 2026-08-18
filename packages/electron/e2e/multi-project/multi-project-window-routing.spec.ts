import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { launchElectronApp, createTempWorkspace, waitForAppReady, TEST_TIMEOUTS } from '../helpers';
import {
  getOpenWorkspaceWindowPaths,
  findWorkspaceWindowByPath,
  getProjectRailItemByPath,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

/**
 * E2E coverage for the "open this project" routing chokepoint
 * (`openOrFocusWorkspaceWindow` / `resolveProjectOpenTarget.ts`) and the
 * "Merge All Windows" command, from the single-window-multi-project plan
 * (nimbalyst-local/plans/single-window-multi-project.md).
 *
 * Unlike `multi-project-rail.spec.ts` (which drives the rail UI directly via
 * `workspace:register-additional` + atom IPC, independent of routing), these
 * tests go through the real production entry point --
 * `window.electronAPI.workspaceManager.openWorkspace()`, exactly what "Open
 * Recent" / the Workspace Manager UI / Quick Open call -- so the routing
 * DECISION itself (same window's rail vs. a brand new `BrowserWindow`) is
 * under test, not just the rail's own rendering once a project is on it.
 *
 * Each test sets `multiProjectMode` explicitly and opens/closes exactly the
 * windows it needs, so a test does not depend on execution order beyond the
 * shared `electronApp` and its first window (workspaceA) staying alive
 * across tests 1-2. The merge test (which may end up closing that very
 * window as a "donor") is deliberately last and discovers its survivor
 * window dynamically rather than assuming which one it is.
 */
test.describe('Multi-Project Window Routing', () => {
  let electronApp: ElectronApplication;
  let page: Page; // workspaceA's window; alive for the whole file except possibly during the last test
  let workspaceA: string;
  let workspaceB: string;
  let workspaceC: string;

  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(30_000);
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
    await waitForAppReady(page);
  });

  test.afterAll(async () => {
    await electronApp?.close();
    await Promise.all([
      fs.rm(workspaceA, { recursive: true, force: true }).catch(() => undefined),
      fs.rm(workspaceB, { recursive: true, force: true }).catch(() => undefined),
      fs.rm(workspaceC, { recursive: true, force: true }).catch(() => undefined),
    ]);
  });

  test("mode ON: opening a second project joins this window's rail instead of opening a new window", async () => {
    // Reload + waitForAppReady + a SIDEBAR_LOAD-scale poll can exceed the
    // 15s default (playwright.config.ts).
    test.setTimeout(30_000);

    await page.evaluate(async () => {
      await window.electronAPI.invoke('app:set-multi-project-mode', true);
    });
    // `multiProjectModeAtom` is only read once at renderer boot
    // (`initOpenProjects`), so reload for the rail to actually paint. The
    // main-process routing decision itself does not need this --
    // `getMultiProjectMode()` is read fresh on every
    // `openOrFocusWorkspaceWindow` call.
    await page.reload();
    await waitForAppReady(page);

    await expect.poll(() => getOpenWorkspaceWindowPaths(electronApp)).toHaveLength(1);
    const windowCountBefore = electronApp.windows().length;

    await page.evaluate(async (workspacePath) => {
      await window.electronAPI.workspaceManager.openWorkspace(workspacePath);
    }, workspaceB);

    const rail = page.locator('[data-testid="project-rail"]');
    const items = rail.locator('[data-testid="project-rail-item"]');
    await expect(items).toHaveCount(2, { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

    const bItem = getProjectRailItemByPath(page, workspaceB);
    await expect(bItem).toHaveClass(/is-active/);

    // No second BrowserWindow was created, and `windowStates` still has only
    // one workspace-mode window (workspaceA's primary path) -- workspaceB
    // joined the rail as an *additional* path, not a new window's primary.
    expect(electronApp.windows().length).toBe(windowCountBefore);
    await expect.poll(() => getOpenWorkspaceWindowPaths(electronApp)).toHaveLength(1);

    // Clean up: close workspaceB from the rail so later tests in this file
    // (in particular the merge test's expected rail count) start from a
    // known one-project rail state. `ProjectRail`'s close handler both
    // drops the atom entry (synchronous -- what `toHaveCount(1)` below
    // observes) and awaits `workspace:unregister-additional` so window1
    // stops referencing workspaceB in main's `additionalWorkspacePaths`;
    // the extra wait gives that IPC round trip time to land before a later
    // test relies on it.
    await bItem.hover();
    page.once('dialog', (dialog) => dialog.accept());
    await bItem.locator('.project-rail-item-close').click();
    await expect(items).toHaveCount(1);
    await page.waitForTimeout(500);
  });

  test('mode OFF: opening a second project still opens a new window (regression guard)', async () => {
    test.setTimeout(30_000);

    await page.evaluate(async () => {
      await window.electronAPI.invoke('app:set-multi-project-mode', false);
    });

    await expect.poll(() => getOpenWorkspaceWindowPaths(electronApp)).toHaveLength(1);

    const [newWindow] = await Promise.all([
      electronApp.waitForEvent('window'),
      page.evaluate(async (workspacePath) => {
        await window.electronAPI.workspaceManager.openWorkspace(workspacePath);
      }, workspaceC),
    ]);
    await newWindow.waitForLoadState('domcontentloaded');
    await expect.poll(() => newWindow.title()).toBe(path.basename(workspaceC));

    await expect.poll(() => getOpenWorkspaceWindowPaths(electronApp)).toHaveLength(2);

    // Close the window this test opened so it doesn't leak into the merge test.
    await electronApp.evaluate(({ BrowserWindow }, title) => {
      BrowserWindow.getAllWindows().find((w) => w.getTitle() === title)?.close();
    }, path.basename(workspaceC));

    await expect.poll(() => getOpenWorkspaceWindowPaths(electronApp)).toHaveLength(1);
  });

  test('"Merge All Windows" folds every open workspace window into one', async () => {
    // Two window opens plus a merge poll (up to 15s) exceeds the 15s default.
    test.setTimeout(45_000);

    const workspaceD = await createTempWorkspace();
    const workspaceE = await createTempWorkspace();
    await fs.writeFile(path.join(workspaceD, 'd.md'), '# D\n', 'utf8');
    await fs.writeFile(path.join(workspaceE, 'e.md'), '# E\n', 'utf8');

    try {
      // Two genuinely separate windows -- opened with the mode OFF so each
      // spawns its own BrowserWindow. This reproduces the plan's "windows
      // already open stay open" gap (Phase 1.4) that "Merge All Windows"
      // exists to relieve without a quit/relaunch.
      await page.evaluate(async () => {
        await window.electronAPI.invoke('app:set-multi-project-mode', false);
      });

      const [windowD] = await Promise.all([
        electronApp.waitForEvent('window'),
        page.evaluate(async (workspacePath) => {
          await window.electronAPI.workspaceManager.openWorkspace(workspacePath);
        }, workspaceD),
      ]);
      await windowD.waitForLoadState('domcontentloaded');

      const [windowE] = await Promise.all([
        electronApp.waitForEvent('window'),
        page.evaluate(async (workspacePath) => {
          await window.electronAPI.workspaceManager.openWorkspace(workspacePath);
        }, workspaceE),
      ]);
      await windowE.waitForLoadState('domcontentloaded');

      await expect.poll(() => getOpenWorkspaceWindowPaths(electronApp)).toHaveLength(3);

      // "Merge All Windows" only makes sense -- and only does anything --
      // with the mode on.
      await page.evaluate(async () => {
        await window.electronAPI.invoke('app:set-multi-project-mode', true);
      });

      // `ApplicationMenu.ts`'s click handler shows a native
      // `dialog.showMessageBox` if anything was refused or a donor was
      // skipped ("Some Windows Stayed Open"). That is not expected in this
      // scenario (no cap, no unsaved changes), but a native modal blocks
      // until dismissed and is NOT interceptable via Playwright's
      // page-level `dialog` event (that only covers renderer
      // alert/confirm/prompt) -- stub it so an unexpected one can't hang
      // the test instead of failing it.
      await electronApp.evaluate(({ dialog }) => {
        dialog.showMessageBox = (() =>
          Promise.resolve({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
      });

      // There is no test-only IPC channel for this command (it is a native
      // menu item -- `ApplicationMenu.ts`'s Window menu). Locate it on the
      // live application menu and invoke its `click` handler directly in
      // the main process. This bypasses the item's `enabled` flag (which is
      // only recomputed when the menu is rebuilt, e.g. on org-window focus
      // change -- not on every window open/close), but that is safe here:
      // `consolidateWorkspaceWindows()` independently re-validates
      // (`getMultiProjectMode()` + window count) before doing anything, per
      // its own doc comment.
      const invoked = await electronApp.evaluate(({ Menu }) => {
        const appMenu = Menu.getApplicationMenu();
        const windowMenu = appMenu?.items.find((item) => item.label === 'Window');
        const mergeItem = windowMenu?.submenu?.items.find(
          (item) => item.label === 'Merge All Windows'
        );
        if (!mergeItem) return false;
        mergeItem.click();
        return true;
      });
      expect(invoked).toBe(true);

      // `consolidateWorkspaceWindows()` seeds donor paths sequentially, each
      // ack up to 2000ms, then closes drained donors -- poll rather than
      // assume a fixed delay.
      await expect
        .poll(() => getOpenWorkspaceWindowPaths(electronApp), { timeout: 15000 })
        .toHaveLength(1);

      // Discover the survivor rather than assuming which window absorbed
      // the others (focus-order-dependent, and not the point of this test).
      const [survivorPrimaryPath] = await getOpenWorkspaceWindowPaths(electronApp);
      const survivor = await findWorkspaceWindowByPath(electronApp, survivorPrimaryPath);
      expect(survivor).not.toBeNull();
      if (!survivor) throw new Error('unreachable');

      await survivor.reload();
      await waitForAppReady(survivor);

      const rail = survivor.locator('[data-testid="project-rail"]');
      const items = rail.locator('[data-testid="project-rail-item"]');
      await expect(items).toHaveCount(3, { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

      const paths = await items.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-project-path'))
      );
      expect(new Set(paths)).toEqual(new Set([workspaceA, workspaceD, workspaceE]));

      // `page` (workspaceA's original window) may have been the donor that
      // got closed by the merge -- reassign it to the survivor so
      // `afterAll`'s cleanup (and any test added after this one) keeps
      // working against a live window.
      page = survivor;
    } finally {
      await Promise.all([
        fs.rm(workspaceD, { recursive: true, force: true }).catch(() => undefined),
        fs.rm(workspaceE, { recursive: true, force: true }).catch(() => undefined),
      ]);
    }
  });
});
