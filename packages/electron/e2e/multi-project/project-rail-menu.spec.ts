import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { launchElectronApp, createTempWorkspace } from '../helpers';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Mirrors TITLE_BAR_BUFFER in runtime's windowControlsClearance.ts.
const TITLE_BAR_BUFFER = 8;

test.describe.configure({ mode: 'serial' });
let app: ElectronApplication | undefined;
let page: Page;
let workspace: string;
let recents: Array<{ path: string; name: string; timestamp: number }>;

test.beforeAll(async () => {
  // Cold Electron/Vite startup has a separate budget from menu interactions.
  test.setTimeout(60_000);
  workspace = await createTempWorkspace();
  await fs.writeFile(path.join(workspace, 'README.md'), '# Rail menu test\n');
  recents = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const name = `Recent-project-${index + 1}`;
    const folder = path.join(workspace, name);
    await fs.mkdir(folder);
    return { path: folder, name, timestamp: Date.now() - index };
  }));
  app = await launchElectronApp({ workspace, permissionMode: 'allow-all' });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.electronAPI?.invoke === 'function');
  await page.evaluate(async () => {
    await window.electronAPI.invoke('app:set-multi-project-mode', true);
    await window.electronAPI.invoke('app-settings:set', 'recent.workspaces', []);
  });
  await page.reload();
  await page.getByTestId('project-rail-add').waitFor();
  const dismiss = page.getByRole('button', { name: 'Not now', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(workspace, { recursive: true, force: true });
});

async function expectMenuInsideWindow() {
  // Floating UI rounds transforms to device pixels; allow one CSS pixel of
  // rounding within the eight-pixel inset, but never allow viewport clipping.
  await expect.poll(() => page.getByTestId('project-rail-add-menu').evaluate(menu => {
    const rect = menu.getBoundingClientRect();
    const overlay = (navigator as Navigator & {
      windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect };
    }).windowControlsOverlay;
    const titlebar = overlay?.visible ? overlay.getTitlebarAreaRect() : null;
    const overlapsControls = titlebar && (
      (titlebar.x > 0 && rect.left < titlebar.x) ||
      (titlebar.right < innerWidth && rect.right > titlebar.right)
    );
    return {
      controls: overlapsControls ? Math.max(0, titlebar.bottom - rect.top) : 0,
      top: Math.max(0, 7 - rect.top),
      bottom: Math.max(0, rect.bottom - (innerHeight - 7)),
      left: Math.max(0, 7 - rect.left),
      right: Math.max(0, rect.right - (innerWidth - 7)),
    };
  }), { timeout: 2000 }).toEqual({ controls: 0, top: 0, bottom: 0, left: 0, right: 0 });
}

test('keeps the entire menu on screen as recent folders load', async () => {
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.getByTestId('project-rail-add').click();
  await expectMenuInsideWindow();
  await page.keyboard.press('Escape');
  // The component still has an empty list cached. Reopening must account for
  // the larger menu when this asynchronous IPC result arrives.
  await page.evaluate(items => window.electronAPI.invoke('app-settings:set', 'recent.workspaces', items), recents);
  await page.getByTestId('project-rail-add').click();
  await expect(page.locator('.project-rail-context-menu-item-recent')).toHaveCount(8);
  await expectMenuInsideWindow();
});

test('repositions on resize and makes the last recent folder reachable by scrolling', async () => {
  await page.setViewportSize({ width: 800, height: 350 });
  await expectMenuInsideWindow();
  const menu = page.getByTestId('project-rail-add-menu');
  expect(await menu.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const last = menu.getByRole('button', { name: new RegExp(recents[7].name) });
  await last.scrollIntoViewIfNeeded();
  await last.click({ trial: true });
  expect(await last.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const menuRect = element.closest('.project-rail-add-menu')!.getBoundingClientRect();
    return rect.top >= menuRect.top && rect.bottom <= menuRect.bottom;
  })).toBe(true);
  await page.evaluate(() => {
    const menu = document.querySelector('.project-rail-add-menu')!;
    menu.scrollTop = 0;
  });
  await expect(menu.getByText('Open folder…', { exact: true })).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.getByTestId('project-rail-add').click();
  await expectMenuInsideWindow();
});

test('keeps a stable height near the window-controls band and grows back after resize', async () => {
  const menu = page.getByTestId('project-rail-add-menu');
  await page.setViewportSize({ width: 1000, height: 600 });
  await expectMenuInsideWindow();
  const naturalHeight = await menu.evaluate(element => element.getBoundingClientRect().height);
  // Exercise the macOS-shaped control band on every platform. The preceding
  // tests also check the real platform's reported window controls.
  const originalOverlay = await page.evaluateHandle(() => Object.getOwnPropertyDescriptor(navigator, 'windowControlsOverlay'));
  await page.evaluate(() => Object.defineProperty(navigator, 'windowControlsOverlay', {
    configurable: true,
    value: { visible: true, getTitlebarAreaRect: () => new DOMRect(80, 0, innerWidth - 80, 38) },
  }));
  try {
    // These are the heights between "fits naturally" and "clamps below the
    // title bar plus its buffer". Using the menu's measured height also works
    // with different UI fonts.
    for (const extraHeight of [21, 26, 31].map(h => h + TITLE_BAR_BUFFER)) {
      await page.setViewportSize({ width: 1000, height: Math.ceil(naturalHeight) + extraHeight });
      await expectMenuInsideWindow();
      const frames = await menu.evaluate(async element => {
        const bounds = [];
        for (let i = 0; i < 12; i++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const rect = element.getBoundingClientRect();
          bounds.push({ top: rect.top, bottom: rect.bottom, height: rect.height, viewportHeight: innerHeight });
        }
        return bounds;
      });
      // A single successful poll could catch the fitting half of a resize
      // loop. Every sampled frame must fit and the height must stay stable.
      for (const frame of frames) {
        expect(frame.top).toBeGreaterThanOrEqual(38 + TITLE_BAR_BUFFER);
        expect(frame.bottom).toBeLessThanOrEqual(frame.viewportHeight - 7);
      }
      expect(Math.max(...frames.map(frame => frame.height)) - Math.min(...frames.map(frame => frame.height))).toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 1000, height: 600 });
    await expectMenuInsideWindow();
    await expect.poll(() => menu.evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0);
    expect(await menu.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(naturalHeight, 0);
  } finally {
    await page.evaluate(original => {
      if (original) Object.defineProperty(navigator, 'windowControlsOverlay', original);
      else Reflect.deleteProperty(navigator, 'windowControlsOverlay');
    }, originalOverlay);
    await originalOverlay.dispose();
  }
});
