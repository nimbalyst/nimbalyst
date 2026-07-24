/**
 * Tracker Kanban drag-to-sort E2E tests.
 *
 * Tests the manual card ordering feature:
 * - Creating multiple tracker items
 * - Switching to kanban view
 * - Verifying cards appear in a column
 * - Dragging a card within a column to reorder
 * - Verifying the new order persists (kanbanSortOrder updated in DB)
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  TEST_TIMEOUTS,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
  waitForWorkspaceReady,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  electronApp = await launchElectronApp({ workspace: workspaceDir, permissionMode: 'allow-all' });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('should create items and display them in kanban view', async () => {
  // Navigate to Tracker mode
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerModeButton).click();
  const trackerSidebar = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerSidebar);
  await trackerSidebar.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

  // Select Bugs type
  const bugsButton = page.locator(`${PLAYWRIGHT_TEST_SELECTORS.trackerTypeButton}[data-tracker-type="bug"]`);
  await bugsButton.click();

  const trackerTable = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTable);
  await trackerTable.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });

  // Create 3 bugs via the toolbar
  for (const title of ['Bug Alpha', 'Bug Beta', 'Bug Gamma']) {
    await page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerToolbarNewButton).click();
    const quickAddInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerQuickAddInput);
    await quickAddInput.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });
    await quickAddInput.fill(title);
    await quickAddInput.press('Enter');
    // Wait for the new row
    const newRow = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTableRow, { hasText: title });
    await expect(newRow).toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 6 });
  }

  // Switch to Kanban view
  await page.locator('button[title="Kanban view"]').click();

  // Wait for kanban board
  const kanbanBoard = page.locator('[data-testid="tracker-kanban-board"]');
  await kanbanBoard.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });

  // Verify all 3 bugs appear as cards in the to-do column
  const todoColumn = page.locator('[data-testid="tracker-kanban-column-to-do"]');
  await todoColumn.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });

  const cards = todoColumn.locator('[data-testid="tracker-kanban-card"]');
  await expect(cards).toHaveCount(3, { timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });
});

test('should reorder cards within a column via drag and drop', async () => {
  // Get the to-do column
  const todoColumn = page.locator('[data-testid="tracker-kanban-column-to-do"]');
  const cards = todoColumn.locator('[data-testid="tracker-kanban-card"]');

  // Record initial order
  const initialTitles: string[] = [];
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    const title = await cards.nth(i).locator('.text-sm.text-nim').textContent();
    initialTitles.push(title?.trim() || '');
  }

  // Drag the last card to the top of the column
  const lastCard = cards.last();
  const firstCard = cards.first();

  const lastBox = await lastCard.boundingBox();
  const firstBox = await firstCard.boundingBox();
  expect(lastBox).toBeTruthy();
  expect(firstBox).toBeTruthy();

  // Perform drag: from center of last card to above first card
  await page.mouse.move(lastBox!.x + lastBox!.width / 2, lastBox!.y + lastBox!.height / 2);
  await page.mouse.down();
  // Move to above the first card
  await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y - 5, { steps: 10 });
  await page.mouse.up();

  // Wait for the reorder to take effect
  await page.waitForTimeout(500);

  // Verify the last card is now first
  const newTitles: string[] = [];
  const newCount = await cards.count();
  for (let i = 0; i < newCount; i++) {
    const title = await cards.nth(i).locator('.text-sm.text-nim').textContent();
    newTitles.push(title?.trim() || '');
  }

  // The last item from initialTitles should now be first
  expect(newTitles[0]).toBe(initialTitles[initialTitles.length - 1]);
});

test('should persist reorder in database via kanbanSortOrder', async () => {
  // Verify the kanbanSortOrder was updated in the DB by checking via evaluate
  // Verify via documentService that items have kanbanSortOrder via customFields
  const result = await page.evaluate(async () => {
    const documentService = (window as any).documentService;
    if (!documentService) return null;
    const items = await documentService.listTrackerItems();
    const bugs = items.filter((i: any) => i.type === 'bug');
    return bugs.map((i: any) => ({
      title: i.title,
      kanbanSortOrder: i.customFields?.kanbanSortOrder ?? null,
    }));
  });

  console.log('[KanbanSort E2E] Sort orders:', JSON.stringify(result, null, 2));

  expect(result).toBeTruthy();
  expect(result!.length).toBe(3);

  // All items should have a kanbanSortOrder
  const withSortOrder = result!.filter((s: any) => s.kanbanSortOrder != null);
  expect(withSortOrder.length).toBe(3);
});
