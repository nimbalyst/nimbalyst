/**
 * Times sessions:list-children IPC against the active backend (SQLite under
 * PLAYWRIGHT=1). Used to verify the WriteCoordinator-bypass experiment landed
 * the write path back under contention-free latency.
 *
 * Not part of the regular sweep — runs only on demand.
 */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'path';
import { promises as fs } from 'fs';
import { createTempWorkspace, launchElectronApp, waitForAppReady } from '../helpers';
import { switchToAgentMode, PLAYWRIGHT_TEST_SELECTORS } from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

test.describe('sessions:list-children IPC latency', () => {
  let electronApp: ElectronApplication;
  let page: Page;
  let workspacePath: string;

  test.beforeAll(async () => {
    workspacePath = await createTempWorkspace();
    await fs.writeFile(path.join(workspacePath, 'test.md'), '# Test\n', 'utf8');
    electronApp = await launchElectronApp({ workspace: workspacePath, permissionMode: 'allow-all' });
    page = await electronApp.firstWindow();
    await waitForAppReady(page);
  });

  test.afterAll(async () => {
    await electronApp?.close();
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  });

  test('measures end-to-end IPC during workstream creation', async () => {
    await switchToAgentMode(page);
    const agentMode = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode);
    await expect(agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput)).toBeVisible({ timeout: 5000 });

    const sessionTabBar = agentMode.locator(PLAYWRIGHT_TEST_SELECTORS.sessionTabBar);
    await expect(sessionTabBar).toBeVisible({ timeout: 5000 });

    // Trigger a workstream + child creation so there's a parent with children.
    await sessionTabBar.locator(PLAYWRIGHT_TEST_SELECTORS.sessionTabNew).click();
    await page.waitForTimeout(800);

    // Find the parent session id from the running renderer state.
    const parentId = await page.evaluate(async () => {
      const ws = await (window as any).electronAPI.invoke('workspace:get-current');
      const result = await (window as any).electronAPI.invoke('sessions:list', ws.path, { includeArchived: false });
      const withChildren = (result.sessions || []).find((s: any) => (s.childCount || 0) > 0);
      return withChildren?.id ?? null;
    });
    expect(parentId).toBeTruthy();

    // Now time sessions:list-children in two scenarios:
    //  (a) idle — no other IPC in flight
    //  (b) interleaved with writes — fire sessions:update-metadata in parallel
    const result = await page.evaluate(async ({ parentId }) => {
      const ws = (await (window as any).electronAPI.invoke('workspace:get-current')).path;

      const time = async (label: string, fn: () => Promise<unknown>, n: number) => {
        const samples: number[] = [];
        for (let i = 0; i < n; i++) {
          const t = performance.now();
          await fn();
          samples.push(performance.now() - t);
        }
        samples.sort((a, b) => a - b);
        return {
          label,
          n: samples.length,
          min: +samples[0].toFixed(2),
          p50: +samples[Math.floor(samples.length * 0.5)].toFixed(2),
          p95: +samples[Math.floor(samples.length * 0.95)].toFixed(2),
          max: +samples[samples.length - 1].toFixed(2),
        };
      };

      const listChildren = () => (window as any).electronAPI.invoke('sessions:list-children', parentId, ws, { includeArchived: false });

      // Warmup
      for (let i = 0; i < 5; i++) await listChildren();

      const idle = await time('idle', listChildren, 30);

      // Concurrent writes via update-metadata
      const writeBurst = (n: number) => Promise.all(
        Array.from({ length: n }, (_, i) =>
          (window as any).electronAPI.invoke('sessions:update-metadata', parentId, { metadata: { burst: i } })
        )
      );
      // Time list-children while writes are concurrently in flight.
      const samples: number[] = [];
      for (let i = 0; i < 30; i++) {
        const writes = writeBurst(5);
        const t = performance.now();
        await listChildren();
        samples.push(performance.now() - t);
        await writes;
      }
      samples.sort((a, b) => a - b);
      const contended = {
        label: 'contended',
        n: samples.length,
        min: +samples[0].toFixed(2),
        p50: +samples[Math.floor(samples.length * 0.5)].toFixed(2),
        p95: +samples[Math.floor(samples.length * 0.95)].toFixed(2),
        max: +samples[samples.length - 1].toFixed(2),
      };

      return { idle, contended };
    }, { parentId });

    // Surface as a test-step annotation so it shows in the reporter output.
    test.info().annotations.push({
      type: 'timing',
      description: `idle: ${JSON.stringify(result.idle)}; contended: ${JSON.stringify(result.contended)}`,
    });
    // eslint-disable-next-line no-console
    console.log('IPC TIMING:', JSON.stringify(result, null, 2));

    expect(result.idle.p95).toBeLessThan(50);
    expect(result.contended.p95).toBeLessThan(50);
  });
});
