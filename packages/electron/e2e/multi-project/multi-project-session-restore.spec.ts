import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { launchElectronApp, createTempWorkspace, waitForAppReady, TEST_TIMEOUTS } from '../helpers';
import { getOpenWorkspaceWindowPaths } from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

/**
 * E2E coverage for session-restore collapse (single-window-multi-project
 * plan, Phase 1.3 -- `computeSessionRestorePlan` in `main/session/SessionState.ts`).
 *
 * Restart-to-verify by nature (per
 * .claude/rules/end-to-end-verification.md): N saved workspace windows +
 * Multi-Project Mode on must collapse into ONE restored window with an
 * N-entry rail and the previously-active project visible, instead of N
 * windows reopening as before the feature. This requires two full
 * `launchElectronApp` cycles against the SAME userData directory, so it
 * cannot join the shared-`beforeAll`-instance pattern the other
 * multi-project specs use (see docs/E2E_TESTING.md's "When Tests CANNOT
 * Share an App").
 *
 * Two environment-dependent assumptions this test relies on, called out so
 * a future flake investigation starts here first:
 *   1. `launchElectronApp`'s second call MUST omit `workspace` and pass
 *      `preserveTestDatabase: true` -- a `--workspace` CLI arg makes
 *      `main/index.ts` skip `restoreSessionState()` entirely
 *      (`shouldSkipSessionRestore`), and the default `launchElectronApp`
 *      behavior wipes `TEST_USER_DATA_DIR` (which holds both the saved
 *      session and the `multiProjectMode` setting) on every launch.
 *   2. Explicitly focusing workspaceB's `BrowserWindow` (via
 *      `electronApp.evaluate`, not a `Page`-level `bringToFront()`, which
 *      goes through Playwright/CDP rather than the Electron API whose
 *      `focus()` call actually fires the native 'focus' event
 *      `windowFocusOrder` listens to) is relied on to make workspaceB
 *      (opened second) the saved window with the highest `focusOrder` --
 *      the "previously active project" `computeSessionRestorePlan` should
 *      keep visible after collapse. If this assertion is ever flaky in CI,
 *      suspect this mechanism first, not a routing bug.
 */
test.describe('Multi-Project Session Restore Collapse', () => {
  let workspaceA: string;
  let workspaceB: string;

  test.beforeAll(async () => {
    workspaceA = await createTempWorkspace();
    workspaceB = await createTempWorkspace();
    await fs.writeFile(path.join(workspaceA, 'a.md'), '# A\n', 'utf8');
    await fs.writeFile(path.join(workspaceB, 'b.md'), '# B\n', 'utf8');
  });

  test.afterAll(async () => {
    await Promise.all([
      fs.rm(workspaceA, { recursive: true, force: true }).catch(() => undefined),
      fs.rm(workspaceB, { recursive: true, force: true }).catch(() => undefined),
    ]);
  });

  test('N saved workspace windows + mode on collapse into one window with N rail entries on relaunch', async () => {
    test.setTimeout(60000);

    // --- Launch 1: create two separate saved workspace windows, turn the
    // mode on, and quit gracefully so a real session gets written to disk. ---
    let electronApp: ElectronApplication = await launchElectronApp({
      workspace: workspaceA,
      env: { NODE_ENV: 'test' },
    });

    const pageA: Page = await electronApp.firstWindow();
    await waitForAppReady(pageA);

    const [pageB] = await Promise.all([
      electronApp.waitForEvent('window'),
      pageA.evaluate(async (workspacePath) => {
        await window.electronAPI.workspaceManager.openWorkspace(workspacePath);
      }, workspaceB),
    ]);
    await pageB.waitForLoadState('domcontentloaded');
    await waitForAppReady(pageB);

    // Focus B's BrowserWindow last -- see assumption (2) above.
    await electronApp.evaluate(({ BrowserWindow }, title) => {
      BrowserWindow.getAllWindows().find((w) => w.getTitle() === title)?.focus();
    }, path.basename(workspaceB));
    await pageB.waitForTimeout(500);

    await pageB.evaluate(async () => {
      await window.electronAPI.invoke('app:set-multi-project-mode', true);
    });

    // Let the window-created / focus-order bookkeeping settle before the
    // graceful quit saves session state over live `windowStates`.
    await pageA.waitForTimeout(1500);
    await electronApp.close();
    // Give the just-closed process a moment to fully exit before relaunching
    // against the same userData dir -- the single-instance lock (still
    // enforced once `PLAYWRIGHT` is deleted for this launch, see assumption
    // (1)) would otherwise make launch 2 hand off to launch 1 and quit
    // immediately instead of actually restoring. Same gap
    // `workspace-agent-state-persistence.spec.ts` uses between its two launches.
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // --- Launch 2: relaunch with session restore enabled, no explicit
    // --workspace, and the userData directory preserved -- see assumption
    // (1) above. ---
    electronApp = await launchElectronApp({
      env: { NODE_ENV: 'test', ENABLE_SESSION_RESTORE: '1' },
      preserveTestDatabase: true,
    });

    try {
      const restoredPage = await electronApp.firstWindow();
      await waitForAppReady(restoredPage);

      // Exactly one workspace-mode window restored, not two.
      await expect
        .poll(() => getOpenWorkspaceWindowPaths(electronApp), { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD })
        .toHaveLength(1);

      // Its rail holds both restored projects.
      const rail = restoredPage.locator('[data-testid="project-rail"]');
      const items = rail.locator('[data-testid="project-rail-item"]');
      await expect(items).toHaveCount(2, { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

      const paths = await items.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-project-path'))
      );
      expect(new Set(paths)).toEqual(new Set([workspaceA, workspaceB]));

      // The previously-active project (B, brought to front last before
      // quit) is the one visible after restore.
      const activeItem = rail.locator('[data-testid="project-rail-item"].is-active');
      await expect(activeItem).toHaveAttribute('data-project-path', workspaceB);
    } finally {
      await electronApp.close();
    }
  });
});
