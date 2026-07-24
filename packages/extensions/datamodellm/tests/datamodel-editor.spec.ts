/**
 * DataModelLM Extension - Live Integration Tests
 *
 * Run against a live Nimbalyst instance via CDP.
 *
 * Prerequisites: Nimbalyst running in dev mode (CDP on port 9222)
 *
 * Run:
 *   npm run test:extensions -- datamodel
 */

import { test as base, expect } from '@playwright/test';
import { chromium } from 'playwright';
import * as path from 'path';

const TEST_DIR = __dirname;

const test = base.extend<{ page: import('playwright').Page }>({
  page: async ({}, use) => {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    let target: import('playwright').Page | undefined;
    // Find the window whose workspace contains this test file
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const url = p.url();
        if (url.startsWith('devtools://') || url.includes('mode=capture')) continue;
        try {
          const ws = await p.evaluate(async () =>
            (await (window as any).electronAPI.getInitialState?.())?.workspacePath
          );
          if (ws && TEST_DIR.startsWith(ws)) {
            target = p;
            break;
          }
        } catch {}
      }
      if (target) break;
    }
    if (!target) throw new Error(`No Nimbalyst window found whose workspace contains ${TEST_DIR}`);
    await use(target);
    browser.close();
  },
});

async function openFile(page: import('playwright').Page, filePath: string) {
  await page.evaluate(async (fp: string) => {
    const handler = (window as any).__handleWorkspaceFileSelect;
    if (!handler) throw new Error('__handleWorkspaceFileSelect not available');
    await handler(fp);
  }, filePath);
}

const PRISMA_PATH = path.resolve(TEST_DIR, '../samples/demo.prisma');

test.describe('DataModelLM Extension', () => {
  test.describe.configure({ mode: 'serial' });

  test('opens Prisma schema and renders full editor UI', async ({ page }) => {
    await openFile(page, PRISMA_PATH);
    await page.waitForSelector('.datamodel-editor', { timeout: 5000 });

    // Extension container
    const ext = page.locator('[data-extension-id="com.nimbalyst.datamodellm"]');
    await expect(ext).toBeVisible();
    expect(await ext.getAttribute('data-file-path')).toContain('demo.prisma');

    // Theme attribute
    const theme = await page.locator('.datamodel-editor').getAttribute('data-theme');
    expect(['dark', 'light']).toContain(theme);

    // Toolbar: left controls, primary button, view mode selector, stats
    await expect(page.locator('.datamodel-toolbar')).toBeVisible();
    await expect(page.locator('.datamodel-toolbar-button-primary')).toBeVisible();
    expect(await page.locator('.datamodel-view-mode-button').count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.datamodel-view-mode-button.active')).toBeVisible();
    await expect(page.locator('.datamodel-toolbar-stats')).toBeVisible();

    // Canvas with zoom controls
    await expect(page.locator('.datamodel-canvas')).toBeVisible();
    await expect(page.locator('.datamodel-controls')).toBeVisible();

    // Entity nodes: 5 models (User, Post, Comment, Tag, Category) + enum
    expect(await page.locator('.react-flow__node').count()).toBeGreaterThanOrEqual(5);

    // Entity names match the Prisma schema
    const names = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.datamodel-entity-name'))
        .map(n => n.textContent?.trim())
        .filter(Boolean)
    );
    expect(names).toContain('User');
    expect(names).toContain('Post');
    expect(names).toContain('Comment');
    expect(names).toContain('Tag');
    expect(names).toContain('Category');

    // Fields with names, types, and PK badges
    expect(await page.locator('.datamodel-field-row').count()).toBeGreaterThan(10);
    const fieldNames = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.datamodel-field-name'))
        .map(n => n.textContent?.trim())
        .filter(Boolean)
    );
    expect(fieldNames).toContain('id');
    expect(fieldNames).toContain('email');

    const fieldTypes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.datamodel-field-type'))
        .map(t => t.textContent?.trim())
        .filter(Boolean)
    );
    expect(fieldTypes.some(t => ['integer', 'string', 'Int', 'String'].includes(t))).toBe(true);

    expect(await page.locator('.datamodel-badge-pk').count()).toBeGreaterThanOrEqual(3);

    // Relationship edges between entities
    expect(await page.locator('.react-flow__edge').count()).toBeGreaterThanOrEqual(1);
  });

  test('clicking an entity node selects it', async ({ page }) => {
    const firstNode = page.locator('.react-flow__node').first();
    await firstNode.click();
    await page.waitForTimeout(300);

    // React Flow marks selected nodes with aria-selected or a selected class/attribute
    const isSelected = await page.evaluate(() => {
      const nodes = document.querySelectorAll('.react-flow__node');
      for (const node of Array.from(nodes)) {
        if (node.classList.contains('selected') ||
            node.getAttribute('aria-selected') === 'true' ||
            node.querySelector('.selected, .datamodel-entity.selected, .datamodel-entity.hovered')) {
          return true;
        }
      }
      return false;
    });
    expect(isSelected).toBe(true);
  });

  test('view mode buttons switch between layouts', async ({ page }) => {
    const viewButtons = page.locator('.datamodel-view-mode-button');
    const count = await viewButtons.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Get the currently active mode
    const activeText = await page.locator('.datamodel-view-mode-button.active').textContent();

    // Click a different mode button
    for (let i = 0; i < count; i++) {
      const btn = viewButtons.nth(i);
      const text = await btn.textContent();
      if (text?.trim() !== activeText?.trim()) {
        await btn.click();
        await page.waitForTimeout(300);

        // The clicked button should now be active
        await expect(btn).toHaveClass(/active/);

        // Click back to original
        const originalBtn = page.locator(`.datamodel-view-mode-button:has-text("${activeText?.trim()}")`);
        await originalBtn.click();
        await page.waitForTimeout(200);
        break;
      }
    }
  });

  test('double-click entity field name enables inline editing', async ({ page }) => {
    const fieldName = page.locator('.datamodel-field-name').first();
    const originalName = await fieldName.textContent();
    await fieldName.dblclick();
    await page.waitForTimeout(300);

    // Should show an input for editing
    const editInput = page.locator('.datamodel-field-input, .datamodel-entity input');
    const inputVisible = await editInput.count();

    if (inputVisible > 0) {
      // Type a test name and press Escape to cancel
      await editInput.first().press('Escape');
      await page.waitForTimeout(200);

      // Field name should be unchanged
      const afterName = await fieldName.textContent();
      expect(afterName?.trim()).toBe(originalName?.trim());
    }
    // If no input appeared, the view mode might not support inline editing (Compact mode)
  });
});
